// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { checkpointSchedule, dueCheckpoints, replayCheckpoint, sealCheckpoint, type Checkpoint } from "./checkpoint";
import { PROTOCOL } from "./evidence";
import { captureObjectName, missedCaptureSlots, pilotTarget, runScheduledCapture, verifyCaptureGeneration, type CaptureSource, type StoredCapture } from "./scheduled-capture";
import { createPrivateCaptureStore } from "./capture-storage";
import { createFakeGcs } from "./fake-gcs";

const target = pilotTarget("synthetic", "pilot");
const secret = "synthetic-authentication-secret-never-deployed";
const authorized = `Bearer ${secret}`;
const config = { enabled: true, secret, target, codeRevision: "synthetic-only", authorization: "local-test" };
const began = "2027-02-20T16:00:00.000Z";
const capturedAt = "2027-02-20T16:00:01.000Z";
const committedAt = "2027-02-20T16:00:02.000Z";
const deadline = checkpointSchedule(target, 28).cutoff;
const source = {
  capturedAt, reference: "synthetic-read", counts: { workouts: 0, races: 0, overrides: 0 },
  coverage: { workouts: "complete", races: "complete", overrides: "complete", workoutsFrom: "2026-01-01", limitations: [] },
  inputs: { workouts: [], races: [], overrides: [] },
} satisfies CaptureSource;

function harness(at = began) {
  let now = at;
  const objects = new Map<string, StoredCapture>();
  const store = {
    verifyPolicy: vi.fn(async () => {}),
    read: vi.fn(async (name: string) => objects.get(name) ?? null),
    create: vi.fn(async (name: string, artifact: Checkpoint) => {
      if (objects.has(name)) return "exists" as const;
      now = committedAt;
      objects.set(name, { createdAt: now, generation: "123", artifact });
      return "created" as const;
    }),
  };
  const readSource = vi.fn(async (): Promise<CaptureSource> => {
    now = capturedAt;
    return structuredClone(source);
  });
  return { objects, store, readSource, now: () => now, setNow: (at: string) => { now = at; } };
}

describe("dormant pilot orchestration", () => {
  it("selects the four Eastern checkpoint dates across DST", () => {
    expect(([28, 14, 7, 1] as const).map(horizon => checkpointSchedule(target, horizon))).toEqual([
      { checkpointDate: "2027-02-20", cutoff: "2027-02-21T04:59:59.999Z" },
      { checkpointDate: "2027-03-06", cutoff: "2027-03-07T04:59:59.999Z" },
      { checkpointDate: "2027-03-13", cutoff: "2027-03-14T04:59:59.999Z" },
      { checkpointDate: "2027-03-19", cutoff: "2027-03-20T03:59:59.999Z" },
    ]);
  });

  it("does no source or storage work when disabled, unauthorized or idle", async () => {
    const ports = harness("2027-02-21T05:00:00.000Z");
    expect(await runScheduledCapture(authorized, { ...config, enabled: false }, ports)).toEqual({ status: "disabled" });
    expect(await runScheduledCapture("Bearer wrong", config, ports)).toEqual({ status: "unauthorized" });
    expect(await runScheduledCapture(authorized, config, ports)).toEqual({ status: "idle" });
    expect(ports.store.verifyPolicy).not.toHaveBeenCalled();
    expect(ports.readSource).not.toHaveBeenCalled();
    expect(missedCaptureSlots(target, ports.now(), new Set())).toMatchObject([{ horizon: 28 }]);
  });

  it("seals a late but same-local-day capture and preserves a model abstention", async () => {
    const ports = harness("2027-02-20T23:00:00.000Z");
    const late = "2027-02-21T04:40:00.000Z";
    ports.readSource.mockImplementationOnce(async () => {
      ports.setNow(late);
      return { ...source, capturedAt: late };
    });
    ports.store.create.mockImplementationOnce(async (name, artifact) => {
      const createdAt = "2027-02-21T04:40:01.000Z";
      ports.setNow(createdAt);
      ports.objects.set(name, { createdAt, generation: "124", artifact });
      return "created";
    });
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ status: "abstained", horizon: 28 });
    const object = [...ports.objects.values()][0];
    const sealed = replayCheckpoint(object.artifact);
    const [slot] = dueCheckpoints([target], began);
    expect(verifyCaptureGeneration(object, slot, ports.now(), "private-test-object").custody).toEqual({
      kind: "checkpoint", digest: sealed.integrityDigest, anchoredAt: object.createdAt, reference: "private-test-object#124",
    });
    expect(sealed).toMatchObject({ cutoff: deadline, capturedAt: late,
      results: { predictions: { experimental: { seconds: null } } } });
    expect(missedCaptureSlots(target, "2027-02-22T00:00:00.000Z", new Set([sealed.key]))).toEqual([]);
  });

  it("reuses the original verified generation on duplicate invocations", async () => {
    const ports = harness();
    expect((await runScheduledCapture(authorized, config, ports)).status).toBe("abstained");
    expect((await runScheduledCapture(authorized, config, ports)).status).toBe("duplicate");
    expect(ports.store.create).toHaveBeenCalledTimes(1);
    expect(ports.readSource).toHaveBeenCalledTimes(1);
  });

  it("verifies the create-only race winner without writing a replacement", async () => {
    const ports = harness();
    ports.store.create.mockImplementationOnce(async (name, artifact) => {
      ports.setNow(committedAt);
      ports.objects.set(name, { generation: "9", createdAt: committedAt, artifact });
      return "exists";
    });
    expect((await runScheduledCapture(authorized, config, ports)).status).toBe("duplicate");
    expect(ports.store.create).toHaveBeenCalledTimes(1);
  });

  it("rejects late, backdated and future-clock captures", async () => {
    const ports = harness();
    ports.readSource.mockImplementationOnce(async () => {
      const late = "2027-02-21T05:00:00.000Z";
      ports.setNow(late);
      return { ...source, capturedAt: late };
    });
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ status: "missed", reason: "capture_too_late" });
    ports.setNow(began);
    ports.readSource.mockResolvedValueOnce({ ...source, capturedAt: "2027-02-20T15:00:00.000Z" });
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ status: "failed", reason: "invalid_capture" });
    ports.readSource.mockResolvedValueOnce({ ...source, capturedAt });
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ status: "failed", reason: "invalid_capture" });
    expect(ports.store.create).not.toHaveBeenCalled();
  });

  it("handles source, policy and storage failures with bounded same-day recovery", async () => {
    const ports = harness();
    ports.store.verifyPolicy.mockRejectedValueOnce(new Error("private"));
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ reason: "storage_policy" });
    expect(ports.readSource).not.toHaveBeenCalled();
    ports.readSource.mockRejectedValueOnce(new Error("private"));
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ reason: "source_failed" });
    ports.store.create.mockRejectedValueOnce(new Error("private"));
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ reason: "storage_failed" });
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ status: "abstained" });
  });

  it("seals an explicit incomplete-coverage abstention", async () => {
    const ports = harness();
    ports.readSource.mockImplementationOnce(async () => {
      ports.setNow(capturedAt);
      return { ...source, counts: { ...source.counts, workouts: 1001 },
        coverage: { ...source.coverage, workouts: "partial", limitations: ["overflow probe"] } };
    });
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ status: "abstained", counts: { workouts: 1001 } });
    expect(replayCheckpoint([...ports.objects.values()][0].artifact).results.coverageReasons).toContain("Incomplete workouts scope (partial)");
  });

  it("withholds on a revision mismatch or an untrusted generation time", async () => {
    const ports = harness();
    ports.readSource.mockImplementationOnce(async () => {
      ports.setNow(capturedAt);
      return { ...source, inputs: { ...source.inputs, overrides: [{ id: "run", revision: "future", availableAt: committedAt, doc: {} }] } };
    });
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ reason: "invalid_capture" });
    expect(ports.store.create).not.toHaveBeenCalled();
    await runScheduledCapture(authorized, config, ports);
    const original = [...ports.objects.values()][0];
    original.createdAt = "2027-02-21T05:00:00.000Z";
    expect(await runScheduledCapture(authorized, config, ports)).toMatchObject({ reason: "unverified_generation" });
  });
});

describe("private Google Cloud Storage adapter with fake transport", () => {
  const name = captureObjectName(dueCheckpoints([target], began)[0].key);
  const bucket = "synthetic-private";
  const retention = 120 * 86400;
  const artifact = sealCheckpoint({
    protocol: PROTOCOL, target, horizon: 28, capturedAt,
    source: { kind: "synthetic", authorization: "local", reference: "fixture", codeRevision: "fixture" },
    coverage: source.coverage, inputs: source.inputs,
  });
  const make = (options: Partial<Parameters<typeof createFakeGcs>[0]> = {}, mode?: "locked" | "unlocked_pilot") => {
    const gcs = createFakeGcs({ bucket, clock: () => committedAt, retentionSeconds: retention, locked: true, ...options });
    const store = createPrivateCaptureStore({ bucket, minimumRetentionSeconds: retention, request: gcs.fetch, retentionMode: mode,
      writer: { principal: "writer", accessToken: async () => "token:writer" },
      verifier: { principal: "reader", accessToken: async () => "token:reader" } });
    return { gcs, store };
  };

  it("uses independent credentials, a create-only precondition and a pinned generation read", async () => {
    const { gcs, store } = make();
    expect(await store.verifyPolicy()).toEqual({ retentionLocked: true });
    expect(await store.create(name, artifact)).toBe("created");
    expect(await store.create(name, artifact)).toBe("exists");
    expect(await store.read(name)).toMatchObject({ generation: "101", createdAt: committedAt, artifact });
    expect(gcs.objects.size).toBe(1);
    const writes = gcs.calls.filter(call => call.method === "POST");
    expect(writes.every(call => call.url.includes("ifGenerationMatch=0") && call.principal === "writer")).toBe(true);
    expect(gcs.calls.filter(call => call.url.includes("alt=media")).every(call => call.url.includes("generation=101") && call.principal === "reader")).toBe(true);
  });

  it("rejects a missing lock, missing retention, failed uploads and mismatched generations", async () => {
    await expect(make({ locked: false }).store.verifyPolicy()).rejects.toThrow("retained bucket");
    await expect(make({ retentionSeconds: 0 }, "unlocked_pilot").store.verifyPolicy()).rejects.toThrow();
    await expect(make({ retentionSeconds: retention - 1 }, "unlocked_pilot").store.verifyPolicy()).rejects.toThrow("retained bucket");
    await expect(make({ publicAccessPrevention: "inherited" }).store.verifyPolicy()).rejects.toThrow("retained bucket");
    const { gcs, store } = make();
    gcs.state.failNextUpload = 1;
    await expect(store.create(name, artifact)).rejects.toThrow("upload failed");
    await store.create(name, artifact);
    gcs.state.retentionSeconds = 0;
    await expect(store.read(name)).rejects.toThrow();
  });

  it("accepts a reversible pilot policy only when asked and reports the weaker guarantee", async () => {
    const { store } = make({ locked: false }, "unlocked_pilot");
    expect(await store.verifyPolicy()).toEqual({ retentionLocked: false });
  });

  it("fails closed for over-privileged or under-privileged identities", async () => {
    const writerCanDelete = make({ permissions: { writer: ["storage.objects.create", "storage.objects.delete"] } });
    await expect(writerCanDelete.store.verifyPolicy()).rejects.toThrow("least-privilege");
    const verifierCanWrite = make({ permissions: { reader: ["storage.objects.get", "storage.buckets.get", "storage.objects.create"] } });
    await expect(verifierCanWrite.store.verifyPolicy()).rejects.toThrow("least-privilege");
    const writerCannotCreate = make({ permissions: { writer: [] } });
    await expect(writerCannotCreate.store.verifyPolicy()).rejects.toThrow("least-privilege");
  });

  it("detects altered bytes of either length against the storage-reported size and hash", async () => {
    const { gcs, store } = make();
    await store.create(name, artifact);
    const length = gcs.objects.get(name)!.size;
    gcs.tamper(name, "x".repeat(length));
    await expect(store.read(name)).rejects.toThrow("hash mismatch");
    gcs.tamper(name, "x");
    await expect(store.read(name)).rejects.toThrow("size mismatch");
  });

  it("supports a verifier-only store that cannot write", async () => {
    const gcs = createFakeGcs({ bucket, clock: () => committedAt, retentionSeconds: retention });
    const store = createPrivateCaptureStore({ bucket, minimumRetentionSeconds: retention, request: gcs.fetch,
      verifier: { principal: "reader", accessToken: async () => "token:reader" } });
    expect(await store.read(name)).toBeNull();
    await expect(store.create(name, artifact)).rejects.toThrow("no writer");
  });
});
