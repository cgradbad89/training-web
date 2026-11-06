// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { canonicalizePerformanceValue } from "@/utils/performanceEvidence";
import { checkpointSchedule, dueCheckpoints, replayCheckpoint, sealCheckpoint, type Checkpoint } from "./checkpoint";
import { PROTOCOL } from "./evidence";
import { captureObjectName, missedCaptureSlots, pilotTarget, runScheduledCapture, verifyCaptureGeneration, type CaptureSource, type StoredCapture } from "./scheduled-capture";
import { createPrivateCaptureStore } from "./capture-storage";

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
  const body = canonicalizePerformanceValue(artifact);
  const policy = { name: bucket, iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } },
    retentionPolicy: { retentionPeriod: String(retention), isLocked: true } };
  const metadata = { bucket, name, generation: "7", timeCreated: committedAt, size: String(Buffer.byteLength(body)),
    retentionExpirationTime: new Date(Date.parse(committedAt) + retention * 1000).toISOString() };
  const transport = (request: typeof fetch) => createPrivateCaptureStore({ bucket, minimumRetentionSeconds: retention, request,
    writer: { principal: "writer", accessToken: async () => "writer-test-token" },
    verifier: { principal: "reader", accessToken: async () => "reader-test-token" },
  });

  it("uses independent credentials, a create-only precondition and a pinned generation read", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(policy)).mockResolvedValueOnce(new Response(null, { status: 412 }))
      .mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response(body));
    const store = transport(request);
    await store.verifyPolicy();
    expect(await store.create(name, artifact)).toBe("exists");
    expect(await store.read(name)).toEqual({ generation: "7", createdAt: committedAt, artifact });
    expect(request.mock.calls[1][0].toString()).toContain("ifGenerationMatch=0");
    expect(request.mock.calls[1][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer writer-test-token" } });
    expect(request.mock.calls[3][0].toString()).toContain("generation=7");
    expect(request.mock.calls[3][1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer reader-test-token" } });
  });

  it("rejects missing lock, failed uploads and mismatched generations", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...policy, retentionPolicy: { ...policy.retentionPolicy, isLocked: false } }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ ...metadata, name: "other" }));
    const store = transport(request);
    await expect(store.verifyPolicy()).rejects.toThrow("locked bucket");
    await expect(store.create(name, artifact)).rejects.toThrow("upload failed");
    await expect(store.read(name)).rejects.toThrow("retained generation");
  });
});
