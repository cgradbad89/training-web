// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { performanceLocalDate } from "@/utils/performanceEvidence";
import { auditCaptures } from "./capture-audit";
import { createImpersonatedCredential } from "./capture-credentials";
import { credentials } from "@grpc/grpc-js";
import { OAuth2Client } from "google-auth-library";
import { handleCaptureRequest, readCaptureSettings, withPlainRequestHeaders, type CaptureEnv } from "./capture-service";
import { createPrivateCaptureStore } from "./capture-storage";
import { checkpointSchedule, dueCheckpoints, replayCheckpoint } from "./checkpoint";
import { HORIZONS, checkpointKey, readTarget } from "./evidence";
import { createFakeGcs } from "./fake-gcs";
import { captureObjectName, pilotTarget, runScheduledCapture, safeCaptureLog, type CaptureSource } from "./scheduled-capture";

vi.mock("./capture-source", () => ({
  createFirestoreProbe: vi.fn(() => async () => undefined),
  createFirestoreCaptureReader: vi.fn(() => async () => { throw new Error("replaced per test"); }),
  createRaceMetadataReader: vi.fn(() => ({
    byId: async () => ({ id: "pilot", raceDate: "2027-03-20", raceDistance: "halfMarathon", isActive: true }),
    active: async () => ({ races: [], overflow: false }),
  })),
}));
import * as sourceModule from "./capture-source";

const SENTINEL = "PRIVATE-WORKOUT-SENTINEL";
const secret = "synthetic-authentication-secret-never-deployed";
const target = pilotTarget("synthetic", "pilot");
const retention = 365 * 86_400;
const audience = "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel-pool/providers/vercel";
const env: CaptureEnv = {
  HM_CAPTURE_ENABLED: "true", CRON_SECRET: secret, HM_CAPTURE_PROJECT_ID: "synthetic-project", HM_CAPTURE_OWNER_UID: "owner-uid",
  HM_CAPTURE_SUBJECT: "synthetic", HM_CAPTURE_RACE_ID: "pilot", HM_CAPTURE_AUTHORIZATION: "approval-ref", HM_CAPTURE_BUCKET: "synthetic-private",
  HM_CAPTURE_RETENTION_MODE: "unlocked_pilot", HM_CAPTURE_WIF_AUDIENCE: audience,
  HM_CAPTURE_WRITER_SA: "writer-sa@synthetic-project.iam.gserviceaccount.com",
  HM_CAPTURE_VERIFIER_SA: "verifier-sa@synthetic-project.iam.gserviceaccount.com",
  HM_CAPTURE_READER_SA: "reader-sa@synthetic-project.iam.gserviceaccount.com", VERCEL_GIT_COMMIT_SHA: "synthetic-sha",
};
const perms = { [env.HM_CAPTURE_WRITER_SA!]: ["storage.objects.create"], [env.HM_CAPTURE_VERIFIER_SA!]: ["storage.objects.get", "storage.buckets.get"] };

function source(capturedAt: string, extra: Partial<CaptureSource> = {}): CaptureSource {
  return { capturedAt, reference: "synthetic-read", counts: { workouts: 1, races: 1, overrides: 0 }, race: "present",
    coverage: { workouts: "complete", races: "complete", overrides: "complete", workoutsFrom: "2026-01-01", limitations: [] },
    inputs: { workouts: [], races: [], overrides: [] }, ...extra };
}

/** A shared fake world: one clock, one bucket, one counting Firestore seam. */
function world(startAt: string, options: { locked?: boolean; permissions?: Record<string, string[]> } = {}) {
  let at = Date.parse(startAt);
  const clock = () => new Date(at).toISOString();
  const gcs = createFakeGcs({ bucket: env.HM_CAPTURE_BUCKET!, clock, retentionSeconds: retention, locked: options.locked ?? false, permissions: options.permissions ?? perms });
  const reads = { opened: 0, disposed: 0 };
  vi.mocked(sourceModule.createFirestoreCaptureReader).mockImplementation(() => async () => {
    at += 1000;
    return source(clock(), { counts: { workouts: 1, races: 1, overrides: 0 } });
  });
  const call = (headers: Record<string, string> = { authorization: `Bearer ${secret}` }, query = "", overrides: Partial<Parameters<typeof handleCaptureRequest>[1]> = {}) =>
    handleCaptureRequest(new Request(`https://example.invalid/api/capture${query}`, { headers }), {
      env, now: clock, request: gcs.fetch, sleep: async () => { at += 5000; }, oidcToken: async () => "platform-oidc-token",
      createFirestore: async () => { reads.opened++; return { db: {} as never, dispose: async () => { reads.disposed++; } }; }, ...overrides,
    });
  return { gcs, reads, call, clock, advance: (ms: number) => { at += ms; }, set: (iso: string) => { at = Date.parse(iso); } };
}

afterEach(() => vi.restoreAllMocks());

describe("activation configuration", () => {
  it("is disabled unless explicitly enabled and never echoes values when invalid", () => {
    expect(readCaptureSettings({})).toBeNull();
    expect(readCaptureSettings({ ...env, HM_CAPTURE_ENABLED: "TRUE" })).toBeNull();
    expect(readCaptureSettings(env)).toMatchObject({ projectId: "synthetic-project", minimumRetentionSeconds: retention });
    const problems: CaptureEnv[] = [
      { ...env, CRON_SECRET: "short" }, { ...env, HM_CAPTURE_RETENTION_MODE: "none" }, { ...env, HM_CAPTURE_MIN_RETENTION_DAYS: "30" },
      { ...env, HM_CAPTURE_READER_SA: env.HM_CAPTURE_WRITER_SA }, { ...env, HM_CAPTURE_OWNER_UID: "a/b" }, { ...env, HM_CAPTURE_BUCKET: undefined },
    ];
    for (const bad of problems) {
      expect(() => readCaptureSettings(bad)).toThrow();
      try { readCaptureSettings(bad); } catch (error) { expect(String(error)).not.toContain(secret); }
    }
  });
});

describe("keyless credentials", () => {
  it("exchanges the platform token, caches the short-lived token and refreshes before expiry", async () => {
    let at = Date.parse("2027-02-20T16:00:00.000Z");
    const gcs = createFakeGcs({ bucket: "b", clock: () => new Date(at).toISOString() });
    const credential = createImpersonatedCredential({ audience, serviceAccountEmail: env.HM_CAPTURE_WRITER_SA!, projectId: "synthetic-project",
      scopes: ["scope"], oidcToken: async () => "oidc", request: gcs.fetch, now: () => at });
    expect(await credential.accessToken()).toBe(`token:${env.HM_CAPTURE_WRITER_SA}`);
    await credential.accessToken();
    expect(gcs.calls.filter(call => call.url.includes("sts.googleapis.com"))).toHaveLength(1);
    at += 850_000;
    await credential.accessToken();
    expect(gcs.calls.filter(call => call.url.includes("sts.googleapis.com"))).toHaveLength(2);
  });

  it("rejects cross-project identities, foreign audiences and leaks nothing on failure", async () => {
    const base = { audience, serviceAccountEmail: env.HM_CAPTURE_WRITER_SA!, projectId: "synthetic-project", scopes: ["scope"], oidcToken: async () => "SECRET-OIDC", request: fetch };
    expect(() => createImpersonatedCredential({ ...base, serviceAccountEmail: "writer-sa@other-project.iam.gserviceaccount.com" })).toThrow();
    expect(() => createImpersonatedCredential({ ...base, audience: "https://attacker.invalid/token" })).toThrow();
    const failing = createImpersonatedCredential({ ...base, request: (async () => new Response("SECRET-BODY", { status: 403 })) as typeof fetch });
    await expect(failing.accessToken()).rejects.toThrow(/^Capture credential exchange failed$/);
  });
});

describe("gRPC credential compatibility", () => {
  it("delivers the bearer token as gRPC metadata (a Headers object would be dropped)", async () => {
    const client = new OAuth2Client();
    client.setCredentials({ access_token: "synthetic-test-token" });
    const metadata = async (source: Parameters<typeof credentials.createFromGoogleCredential>[0]) =>
      (await credentials.createFromGoogleCredential(source).generateMetadata({ service_url: "https://firestore.googleapis.com/google.firestore.v1.Firestore" })).get("authorization");
    expect(await metadata(client)).toEqual([]);
    expect(await metadata(withPlainRequestHeaders(client))).toEqual(["Bearer synthetic-test-token"]);
  });
});

describe("collector request handling", () => {
  it("does no network work when disabled, unauthorized, mismatched, invalid or idle", async () => {
    const w = world("2027-02-19T16:00:00.000Z");
    expect((await w.call(undefined, "", { env: {} })).status).toBe(404);
    expect((await w.call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await w.call({})).status).toBe(401);
    expect((await w.call(undefined, "", { env: { ...env, CRON_SECRET: "short" } })).status).toBe(500);
    expect((await w.call(undefined, "?race=other")).status).toBe(400);
    const idle = await w.call();
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ status: "idle" });
    expect(w.gcs.calls).toEqual([]);
    expect(w.reads.opened).toBe(0);
  });

  it("captures a due checkpoint end to end with create-only storage and a verified receipt", async () => {
    const w = world("2027-02-20T17:00:00.000Z");
    const response = await w.call();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "abstained", horizon: 28, checkpointDate: "2027-02-20", retentionLocked: false, generation: "101" });
    expect(w.gcs.objects.size).toBe(1);
    expect(w.reads.opened).toBe(1);
    expect(w.reads.disposed).toBe(1);
    // The same scheduler slot delivered twice, and a later retry slot, never replace the original.
    w.advance(3_600_000);
    expect(await (await w.call()).json()).toMatchObject({ status: "duplicate", generation: "101" });
    expect(w.gcs.objects.size).toBe(1);
    expect(w.reads.opened).toBe(1);
  });

  it("fails safely and reads nothing when storage permissions are wrong", async () => {
    const w = world("2027-02-20T17:00:00.000Z", { permissions: { ...perms, [env.HM_CAPTURE_WRITER_SA!]: ["storage.objects.create", "storage.objects.delete"] } });
    const response = await w.call();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: "failed", reason: "storage_policy" });
    expect(w.reads.opened).toBe(0);
    expect(w.gcs.objects.size).toBe(0);
  });

  it("runs a preflight that creates no object and reports bounded checks", async () => {
    const ok = world("2027-01-05T17:00:00.000Z");
    expect(await (await ok.call(undefined, "?mode=preflight")).json()).toEqual({ status: "preflight_ok", checks: { policy: true, identities: true, firestore: true, enrollment: { pinned: "present", autoEnabled: false } } });
    expect(ok.gcs.objects.size).toBe(0);
    const bad = world("2027-01-05T17:00:00.000Z", { locked: false });
    // Reversible policy is acceptable only in pilot mode.
    const locked = await bad.call(undefined, "?mode=preflight", { env: { ...env, HM_CAPTURE_RETENTION_MODE: "locked" } });
    expect(await locked.json()).toMatchObject({ status: "preflight_failed", checks: { policy: false } });
    const unauth = await ok.call({ authorization: "Bearer wrong" }, "?mode=preflight");
    expect(unauth.status).toBe(401);
  });

  it("reports a Firestore failure with only a stage and numeric status code", async () => {
    const w = world("2027-01-05T17:00:00.000Z");
    vi.mocked(sourceModule.createFirestoreProbe).mockImplementationOnce(() => async () => { throw Object.assign(new Error("PRIVATE-DETAIL Request had insufficient authentication scopes"), { code: 7 }); });
    const text = await (await w.call(undefined, "?mode=preflight")).text();
    expect(JSON.parse(text)).toEqual({ status: "preflight_failed", checks: { policy: true, identities: true, firestore: false, firestoreStage: "read", firestoreCode: 7, firestoreReason: "scope" } });
    expect(text).not.toContain("PRIVATE-DETAIL");
    const openFails = await w.call(undefined, "?mode=preflight", { createFirestore: async () => { throw new Error("no credential"); } });
    expect(await openFails.json()).toMatchObject({ checks: { firestore: false, firestoreStage: "open" } });
    expect(w.gcs.objects.size).toBe(0);
  });

  it("keeps private payloads, credentials and tokens out of responses and logs", async () => {
    const w = world("2027-02-20T17:00:00.000Z");
    vi.mocked(sourceModule.createFirestoreCaptureReader).mockImplementation(() => async () => {
      w.advance(1000);
      return source(w.clock(), { inputs: { workouts: [], races: [], overrides: [{ id: SENTINEL, revision: "x", availableAt: w.clock(), doc: { note: SENTINEL } }] } });
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await w.call();
    const text = JSON.stringify([await response.text(), info.mock.calls]);
    for (const forbidden of [SENTINEL, secret, "platform-oidc-token", "sts-", "token:"]) expect(text).not.toContain(forbidden);
    expect(info).toHaveBeenCalledTimes(1);
    expect(safeCaptureLog({ status: "captured", generation: "1" })).not.toContain("workouts\":[");
  });
});

describe("schedule, retry and concurrency", () => {
  it("fires on exactly the four Eastern checkpoint days and only does work then", async () => {
    const dates = new Set<string>();
    for (let day = 0; day < 40; day++) {
      for (const hour of [13, 17, 21]) {
        const at = new Date(Date.UTC(2027, 1, 14 + day, hour)).toISOString();
        const store = { verifyPolicy: vi.fn(async () => undefined), read: vi.fn(async () => null), create: vi.fn() };
        const readSource = vi.fn(async (): Promise<CaptureSource> => { throw new Error("synthetic source outage"); });
        const result = await runScheduledCapture(`Bearer ${secret}`, { enabled: true, secret, target, authorization: "a", codeRevision: "r" }, { now: () => at, readSource, store });
        if (result.status === "idle") {
          expect(store.verifyPolicy).not.toHaveBeenCalled();
          expect(store.read).not.toHaveBeenCalled();
          expect(readSource).not.toHaveBeenCalled();
        } else {
          dates.add(result.checkpointDate!);
        }
      }
    }
    expect([...dates].sort()).toEqual(["2027-02-20", "2027-03-06", "2027-03-13", "2027-03-19"]);
  });

  it("keeps every cron slot inside its New York checkpoint day across DST and has correct cutoffs", () => {
    for (const horizon of HORIZONS) {
      const { checkpointDate, cutoff } = checkpointSchedule(target, horizon);
      for (const hour of [13, 17, 21]) {
        const at = `${checkpointDate}T${String(hour).padStart(2, "0")}:30:00.000Z`;
        expect(performanceLocalDate(at, "America/New_York")).toBe(checkpointDate);
        expect(at < cutoff).toBe(true);
      }
      expect(performanceLocalDate(cutoff, "America/New_York")).toBe(checkpointDate);
      expect(performanceLocalDate(new Date(Date.parse(cutoff) + 1).toISOString(), "America/New_York")).not.toBe(checkpointDate);
    }
    const spring = readTarget({ subject: "s", raceId: "r", raceDate: "2027-03-15", timeZone: "America/New_York" });
    expect(checkpointSchedule(spring, 1)).toEqual({ checkpointDate: "2027-03-14", cutoff: "2027-03-15T03:59:59.999Z" });
    const fall = readTarget({ subject: "s", raceId: "r", raceDate: "2027-11-08", timeZone: "America/New_York" });
    expect(checkpointSchedule(fall, 1)).toEqual({ checkpointDate: "2027-11-07", cutoff: "2027-11-08T04:59:59.999Z" });
    // DST change day: the local day is 23 or 25 hours long, but the 21:30Z slot is still that local day.
    expect(performanceLocalDate("2027-03-14T21:30:00.000Z", "America/New_York")).toBe("2027-03-14");
    expect(performanceLocalDate("2027-11-07T21:30:00.000Z", "America/New_York")).toBe("2027-11-07");
  });

  it("retries transient failures inside the invocation, never across the cutoff or budget, and never retries policy", async () => {
    const w = world("2027-02-20T17:00:00.000Z");
    w.gcs.state.failNextUpload = 1;
    const result = await (await w.call()).json();
    expect(result).toMatchObject({ status: "abstained", attempts: 2 });
    expect(w.gcs.objects.size).toBe(1);

    const near = world("2027-02-21T04:59:50.000Z");
    near.gcs.state.failNextRead = 3;
    expect(await (await near.call()).json()).toMatchObject({ status: "failed", reason: "storage_failed" });
    expect(near.gcs.objects.size).toBe(0);

    const policy = world("2027-02-20T17:00:00.000Z", { locked: false });
    const response = await policy.call(undefined, "", { env: { ...env, HM_CAPTURE_RETENTION_MODE: "locked" } });
    const body = await response.json();
    expect(body).toMatchObject({ reason: "storage_policy" });
    expect(body.attempts).toBeUndefined();
    expect(policy.reads.opened).toBe(0);
  });

  it("disposes the Firestore client of every attempt, including failed and retried ones (Phase 3G)", async () => {
    // Source fails once, then succeeds: two clients opened, both terminated (previously only the last was).
    const recovered = world("2027-02-20T17:00:00.000Z");
    let calls = 0;
    vi.mocked(sourceModule.createFirestoreCaptureReader).mockImplementation(() => async () => {
      recovered.advance(1000);
      if (++calls === 1) throw new Error("synthetic transient outage");
      return source(recovered.clock());
    });
    expect(await (await recovered.call()).json()).toMatchObject({ status: "abstained", attempts: 2 });
    expect(recovered.reads).toEqual({ opened: 2, disposed: 2 });

    // Every attempt fails: all clients are still terminated and nothing is stored.
    const failing = world("2027-02-20T17:00:00.000Z");
    vi.mocked(sourceModule.createFirestoreCaptureReader).mockImplementation(() => async () => { failing.advance(1000); throw new Error("synthetic outage"); });
    expect(await (await failing.call()).json()).toMatchObject({ status: "failed", reason: "source_failed" });
    expect(failing.reads.opened).toBe(3);
    expect(failing.reads.disposed).toBe(failing.reads.opened);
    expect(failing.gcs.objects.size).toBe(0);

    // A client that cannot be opened never leaves a dangling handle, and a failing dispose never masks the result.
    const unopened = world("2027-02-20T17:00:00.000Z");
    expect(await (await unopened.call(undefined, "", { createFirestore: async () => { throw new Error("no credential"); } })).json())
      .toMatchObject({ status: "failed", reason: "source_failed" });
    const brokenDispose = world("2027-02-20T17:00:00.000Z");
    vi.mocked(sourceModule.createFirestoreCaptureReader).mockImplementation(() => async () => { brokenDispose.advance(1000); return source(brokenDispose.clock()); });
    let disposeAttempts = 0;
    const result = await (await brokenDispose.call(undefined, "", {
      createFirestore: async () => ({ db: {} as never, dispose: async () => { disposeAttempts++; throw new Error("terminate failed"); } }),
    })).json();
    expect(result).toMatchObject({ status: "abstained" });
    expect(disposeAttempts).toBe(1);
  });

  it("converts an unexpected create error into a verified duplicate only when the original generation exists", async () => {
    const w = world("2027-02-20T17:00:00.000Z");
    w.gcs.state.conflictStatus = 403;
    const [a, b] = await Promise.all([w.call(), w.call()]);
    const statuses = [(await a.json()).status, (await b.json()).status].sort();
    expect(w.gcs.objects.size).toBe(1);
    expect(statuses.filter(status => status === "duplicate").length + statuses.filter(status => status === "abstained").length).toBe(2);
    expect(statuses).toContain("abstained");
  });

  it("refuses to seal when the enrolled race disagrees and never writes", async () => {
    const w = world("2027-02-20T17:00:00.000Z");
    vi.mocked(sourceModule.createFirestoreCaptureReader).mockImplementation(() => async () => { w.advance(1000); return source(w.clock(), { race: "date_mismatch" }); });
    expect(await (await w.call()).json()).toMatchObject({ status: "failed", reason: "enrollment_mismatch" });
    expect(w.gcs.objects.size).toBe(0);
  });

  it("never backdates: a post-cutoff run is idle or missed and a missing slot is reported, not fabricated", async () => {
    const w = world("2027-02-21T05:00:00.000Z");
    expect(await (await w.call()).json()).toEqual({ status: "idle" });
    expect(w.gcs.objects.size).toBe(0);
    const store = createPrivateCaptureStore({ bucket: env.HM_CAPTURE_BUCKET!, minimumRetentionSeconds: retention, retentionMode: "unlocked_pilot", request: w.gcs.fetch,
      verifier: { principal: env.HM_CAPTURE_VERIFIER_SA!, accessToken: async () => `token:${env.HM_CAPTURE_VERIFIER_SA}` } });
    const report = await auditCaptures(target, "2027-02-22T00:00:00.000Z", store);
    expect(report.rows.map(row => row.status)).toEqual(["missed", "not_due", "not_due", "not_due"]);
    expect(report.healthy).toBe(false);
    expect(report.checkpoints).toEqual([]);
  });
});

describe("four-checkpoint pilot, retrieval and independent verification", () => {
  it("captures all four dates, verifies each original generation and replays every artifact", async () => {
    const w = world("2027-02-20T17:00:00.000Z");
    for (const day of ["2027-02-20", "2027-03-06", "2027-03-13", "2027-03-19"]) {
      w.set(`${day}T17:00:00.000Z`);
      expect((await (await w.call()).json()).status).toBe("abstained");
    }
    expect(w.gcs.objects.size).toBe(4);
    const store = createPrivateCaptureStore({ bucket: env.HM_CAPTURE_BUCKET!, minimumRetentionSeconds: retention, retentionMode: "unlocked_pilot", request: w.gcs.fetch,
      verifier: { principal: env.HM_CAPTURE_VERIFIER_SA!, accessToken: async () => `token:${env.HM_CAPTURE_VERIFIER_SA}` } });
    const report = await auditCaptures(target, "2027-03-21T12:00:00.000Z", store);
    expect(report.healthy).toBe(true);
    expect(report.rows.map(row => row.status)).toEqual(Array(4).fill("verified"));
    expect(report.custody.map(entry => entry.digest)).toEqual(report.checkpoints.map(checkpoint => checkpoint.integrityDigest));
    for (const checkpoint of report.checkpoints) expect(replayCheckpoint(JSON.parse(JSON.stringify(checkpoint))).integrityDigest).toBe(checkpoint.integrityDigest);
    expect(report.checkpoints.map(checkpoint => checkpoint.horizon)).toEqual([28, 14, 7, 1]);
    // Every object is written once, create-only, and read by the verifier alone.
    expect(w.gcs.calls.filter(call => call.method === "POST" && call.url.includes("/upload/")).every(call => call.url.includes("ifGenerationMatch=0"))).toBe(true);
    expect(w.gcs.calls.filter(call => call.url.includes("alt=media")).every(call => call.principal === env.HM_CAPTURE_VERIFIER_SA)).toBe(true);

    // Tampering, deletion and a swapped later generation are all detected after the fact.
    const name = captureObjectName(checkpointKey(target, 7));
    w.gcs.remove(name);
    expect((await auditCaptures(target, "2027-03-21T12:00:00.000Z", store)).rows[2].status).toBe("missed");
    const lateName = captureObjectName(checkpointKey(target, 14));
    const pristine = [...w.gcs.objects.entries()].find(([key]) => key === lateName)![1];
    pristine.timeCreated = "2027-03-08T00:00:00.000Z";
    expect((await auditCaptures(target, "2027-03-21T12:00:00.000Z", store)).rows[1].status).toBe("unverified");
  });

  it("keeps the Phase 3D slot keys, due dates and object names stable", () => {
    const [slot] = dueCheckpoints([target], "2027-03-19T17:00:00.000Z");
    expect(slot.horizon).toBe(1);
    expect(captureObjectName(slot.key)).toMatch(/^half-marathon\/v1\/[a-f0-9]{64}\.json$/);
  });
});
