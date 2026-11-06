// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateCaptureStore } from "./capture-storage";
import { auditCaptures, auditEnrolledCaptures } from "./capture-audit";
import { handleCaptureRequest, readCaptureSettings, type CaptureEnv } from "./capture-service";
import { checkpointKey } from "./evidence";
import { createFakeGcs } from "./fake-gcs";
import type { RaceMeta } from "./enrollment";
import { captureObjectName, pilotTarget, type CaptureSource } from "./scheduled-capture";

const reader = vi.hoisted(() => ({
  active: { races: [] as unknown[], overflow: false }, activeError: false, activeCalls: 0,
  pinned: { id: "march-race", raceDate: "2027-03-20", raceDistance: "halfMarathon", isActive: true } as unknown,
}));
vi.mock("./capture-source", () => ({
  createFirestoreProbe: vi.fn(() => async () => undefined),
  createFirestoreCaptureReader: vi.fn(() => async () => { throw new Error("replaced per test"); }),
  createRaceMetadataReader: vi.fn(() => ({
    active: async () => { reader.activeCalls++; if (reader.activeError) throw new Error("synthetic metadata outage"); return reader.active; },
    byId: async () => reader.pinned,
  })),
}));
import * as sourceModule from "./capture-source";

const secret = "synthetic-authentication-secret-never-deployed";
const OWNER = "PRIVATE-OWNER-UID";
const audience = "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel-pool/providers/vercel";
const env: CaptureEnv = {
  HM_CAPTURE_ENABLED: "true", CRON_SECRET: secret, HM_CAPTURE_PROJECT_ID: "synthetic-project", HM_CAPTURE_OWNER_UID: OWNER,
  HM_CAPTURE_SUBJECT: "synthetic", HM_CAPTURE_RACE_ID: "march-race", HM_CAPTURE_AUTHORIZATION: "approval-ref", HM_CAPTURE_BUCKET: "synthetic-private",
  HM_CAPTURE_RETENTION_MODE: "unlocked_pilot", HM_CAPTURE_WIF_AUDIENCE: audience,
  HM_CAPTURE_WRITER_SA: "writer-sa@synthetic-project.iam.gserviceaccount.com",
  HM_CAPTURE_VERIFIER_SA: "verifier-sa@synthetic-project.iam.gserviceaccount.com",
  HM_CAPTURE_READER_SA: "reader-sa@synthetic-project.iam.gserviceaccount.com", VERCEL_GIT_COMMIT_SHA: "synthetic-sha",
};
const auto: CaptureEnv = { ...env, HM_CAPTURE_AUTO_ENROLL: "true" };
const perms = { [env.HM_CAPTURE_WRITER_SA!]: ["storage.objects.create"], [env.HM_CAPTURE_VERIFIER_SA!]: ["storage.objects.get", "storage.buckets.get"] };
const half = (id: string, raceDate: string, extra: Partial<RaceMeta> = {}): RaceMeta => ({ id, raceDate, raceDistance: "halfMarathon", isActive: true, ...extra });

function source(capturedAt: string): CaptureSource {
  return { capturedAt, reference: "synthetic-read", counts: { workouts: 1, races: 1, overrides: 0 }, race: "present",
    coverage: { workouts: "complete", races: "complete", overrides: "complete", workoutsFrom: "2026-01-01", limitations: [] },
    inputs: { workouts: [], races: [], overrides: [] } };
}

function world(startAt: string, options: { env?: CaptureEnv } = {}) {
  reader.active = { races: [], overflow: false }; reader.activeError = false; reader.activeCalls = 0;
  reader.pinned = { id: "march-race", raceDate: "2027-03-20", raceDistance: "halfMarathon", isActive: true };
  let at = Date.parse(startAt);
  const clock = () => new Date(at).toISOString();
  const gcs = createFakeGcs({ bucket: env.HM_CAPTURE_BUCKET!, clock, retentionSeconds: 365 * 86_400, locked: false, permissions: perms });
  const clients = { opened: 0, disposed: 0 };
  vi.mocked(sourceModule.createFirestoreCaptureReader).mockImplementation(() => async () => { at += 1000; return source(clock()); });
  const call = (query = "", overrides: Partial<Parameters<typeof handleCaptureRequest>[1]> = {}) =>
    handleCaptureRequest(new Request(`https://example.invalid/api/capture${query}`, { headers: { authorization: `Bearer ${secret}` } }), {
      env: options.env ?? auto, now: clock, request: gcs.fetch, sleep: async () => { at += 5000; }, oidcToken: async () => "platform-oidc-token",
      createFirestore: async () => { clients.opened++; return { db: {} as never, dispose: async () => { clients.disposed++; } }; }, ...overrides,
    });
  return { gcs, clients, call, set: (iso: string) => { at = Date.parse(iso); } };
}

afterEach(() => vi.restoreAllMocks());

const verifier = (w: { gcs: ReturnType<typeof createFakeGcs> }) => createPrivateCaptureStore({
  bucket: env.HM_CAPTURE_BUCKET!, minimumRetentionSeconds: 365 * 86_400, retentionMode: "unlocked_pilot", request: w.gcs.fetch,
  verifier: { principal: env.HM_CAPTURE_VERIFIER_SA!, accessToken: async () => `token:${env.HM_CAPTURE_VERIFIER_SA}` } });

describe("dormant by default", () => {
  it("is off unless HM_CAPTURE_AUTO_ENROLL is exactly true, and then performs no discovery", async () => {
    expect(readCaptureSettings(env)?.autoEnroll).toBe(false);
    expect(readCaptureSettings({ ...env, HM_CAPTURE_AUTO_ENROLL: "TRUE" })?.autoEnroll).toBe(false);
    expect(readCaptureSettings({ ...env, HM_CAPTURE_AUTO_ENROLL: "1" })?.autoEnroll).toBe(false);
    expect(readCaptureSettings(auto)?.autoEnroll).toBe(true);
    const off = world("2027-01-05T17:00:00.000Z", { env });
    expect(await (await off.call()).json()).toEqual({ status: "idle" });
    expect(off.clients.opened).toBe(0);
    expect(reader.activeCalls).toBe(0);
    expect(off.gcs.calls).toEqual([]);
  });

  it("rejects an invalid time zone without echoing it", () => {
    expect(() => readCaptureSettings({ ...auto, HM_CAPTURE_TIME_ZONE: "Not/AZone" })).toThrow("HM_CAPTURE_TIME_ZONE is invalid");
  });
});

describe("automatic enrollment, when enabled", () => {
  it("does one bounded metadata read on an idle day and touches no storage or workout source", async () => {
    const w = world("2027-01-05T17:00:00.000Z");
    const response = await w.call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "idle", tracked: 1, notes: ["none_eligible"], enrollments: [] });
    expect(reader.activeCalls).toBe(1);
    expect(w.clients).toEqual({ opened: 1, disposed: 1 });
    expect(w.gcs.calls).toEqual([]);
    expect(sourceModule.createFirestoreCaptureReader).not.toHaveBeenCalled();
  });

  it("tracks the saved active September race with no environment change and writes under its own keys", async () => {
    const w = world("2027-08-07T17:00:00.000Z");
    reader.active = { races: [half("sept", "2027-09-04")], overflow: false };
    const body = await (await w.call()).json();
    expect(body).toMatchObject({ status: "abstained", checkpointDate: "2027-08-07", horizon: 28, tracked: 2 });
    expect(body.enrollments).toHaveLength(1);
    expect(w.gcs.objects.size).toBe(1);
    const septTarget = { subject: "synthetic", raceId: "sept", raceDate: "2027-09-04", timeZone: "America/New_York" };
    const audit = await auditCaptures(septTarget, "2027-08-07T18:00:00.000Z", verifier(w));
    expect(audit.rows[0]).toMatchObject({ horizon: 28, status: "verified" });
    // Duplicate cron delivery creates nothing new and keeps the original generation.
    const again = await (await w.call()).json();
    expect(again.status).toBe("duplicate");
    expect(w.gcs.objects.size).toBe(1);
    // Every opened client was closed: one discovery client plus one per capture attempt, twice.
    expect(w.clients.disposed).toBe(w.clients.opened);
  });

  it("keeps capturing March while the next race is active, then stays idle on non-checkpoint days", async () => {
    const w = world("2027-02-20T17:00:00.000Z");
    reader.active = { races: [half("sept", "2027-09-04")], overflow: false };
    expect(await (await w.call()).json()).toMatchObject({ status: "abstained", horizon: 28, checkpointDate: "2027-02-20" });
    const marchName = captureObjectName(checkpointKey(pilotTarget("synthetic", "march-race"), 28));
    expect([...w.gcs.objects.keys()]).toEqual([expect.stringContaining(marchName)]);
    w.set("2027-02-21T17:00:00.000Z");
    expect(await (await w.call()).json()).toMatchObject({ status: "idle" });
    expect(w.gcs.objects.size).toBe(1);
  });

  it("captures March even when discovery fails, overflows or conflicts", async () => {
    for (const setup of [
      () => { reader.activeError = true; },
      () => { reader.active = { races: [], overflow: true }; },
      () => { reader.active = { races: [half("a", "2027-09-04"), half("b", "2027-10-09")], overflow: false }; },
    ]) {
      const w = world("2027-02-20T17:00:00.000Z");
      setup();
      const body = await (await w.call()).json();
      expect(body).toMatchObject({ status: "abstained", checkpointDate: "2027-02-20", tracked: 1 });
      expect(w.gcs.objects.size).toBe(1);
      expect(w.clients.disposed).toBe(w.clients.opened);
    }
  });

  it("enrolls nobody on conflict and says so, rather than choosing one arbitrarily", async () => {
    const w = world("2027-08-07T17:00:00.000Z");
    reader.active = { races: [half("a", "2027-09-04"), half("b", "2027-09-04")], overflow: false };
    expect(await (await w.call()).json()).toMatchObject({ status: "idle", tracked: 1, notes: ["conflict"] });
    expect(w.gcs.objects.size).toBe(0);
  });

  it("creates no historical snapshots for a race that is activated late", async () => {
    const w = world("2027-08-25T17:00:00.000Z");
    reader.active = { races: [half("sept", "2027-09-04")], overflow: false };
    expect((await (await w.call()).json()).status).toBe("idle");
    expect(w.gcs.objects.size).toBe(0);
    w.set("2027-08-28T17:00:00.000Z");
    expect(await (await w.call()).json()).toMatchObject({ horizon: 7, checkpointDate: "2027-08-28" });
    expect(w.gcs.objects.size).toBe(1);
  });

  it("captures two races due on the same day as two distinct sealed objects", async () => {
    // Race on 2027-03-27: its 14-day checkpoint is March 13, the same day as March 20's 7-day checkpoint.
    const w = world("2027-03-13T17:00:00.000Z");
    reader.active = { races: [half("later", "2027-03-27")], overflow: false };
    const body = await (await w.call()).json();
    expect(body.enrollments).toHaveLength(2);
    expect(w.gcs.objects.size).toBe(2);
    expect(new Set(body.enrollments.map((entry: { ref: string }) => entry.ref)).size).toBe(2);
  });

  it("lets a caller narrow to a tracked race but never introduce or select another", async () => {
    const w = world("2027-08-07T17:00:00.000Z");
    reader.active = { races: [half("sept", "2027-09-04")], overflow: false };
    const rejected = await w.call("?race=someone-elses-race");
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ status: "rejected", reason: "enrollment_mismatch" });
    expect(w.gcs.objects.size).toBe(0);
    const narrowed = await (await w.call("?race=sept")).json();
    expect(narrowed.enrollments).toHaveLength(1);
  });

  it("keeps race ids, the owner id, tokens and secrets out of responses and logs", async () => {
    const w = world("2027-08-07T17:00:00.000Z");
    reader.active = { races: [half("sept-private-id", "2027-09-04")], overflow: false };
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const text = JSON.stringify([await (await w.call()).text(), info.mock.calls]);
    for (const forbidden of ["sept-private-id", "march-race", OWNER, secret, "platform-oidc-token", "2027-09-04"]) expect(text).not.toContain(forbidden);
    expect(info).toHaveBeenCalled();
  });

  it("does no discovery and no work for an unauthenticated request", async () => {
    const w = world("2027-08-07T17:00:00.000Z");
    const response = await handleCaptureRequest(new Request("https://example.invalid/api/capture", { headers: { authorization: "Bearer wrong" } }), {
      env: auto, now: () => "2027-08-07T17:00:00.000Z", request: w.gcs.fetch,
    });
    expect(response.status).toBe(401);
    expect(reader.activeCalls).toBe(0);
    expect(w.gcs.calls).toEqual([]);
  });

  it("retries a transient storage failure on a discovered race and disposes every client", async () => {
    const w = world("2027-08-07T17:00:00.000Z");
    reader.active = { races: [half("sept", "2027-09-04")], overflow: false };
    w.gcs.state.failNextUpload = 1;
    expect(await (await w.call()).json()).toMatchObject({ status: "abstained", enrollments: [expect.objectContaining({ status: "abstained" })] });
    expect(w.clients.disposed).toBe(w.clients.opened);
  });
});

describe("preflight enrollment diagnostics", () => {
  it("reports whether the armed race matches the stored race without exposing identifiers", async () => {
    const present = world("2027-01-05T17:00:00.000Z");
    const ok = await (await present.call("?mode=preflight")).json();
    expect(ok).toMatchObject({ status: "preflight_ok", checks: { enrollment: { pinned: "present", autoEnabled: true, discovery: { eligible: 0 } } } });
    for (const [stored, label] of [[null, "absent"], [{ id: "march-race", raceDate: "2027-03-21", raceDistance: "halfMarathon", isActive: true }, "date_mismatch"],
      [{ id: "march-race", raceDate: "2027-03-20", raceDistance: "10K", isActive: true }, "not_half_marathon"]] as const) {
      const w = world("2027-01-05T17:00:00.000Z");
      reader.pinned = stored;
      const response = await w.call("?mode=preflight");
      const body = await response.json();
      expect(response.status).toBe(500);
      expect(body).toMatchObject({ status: "preflight_failed", checks: { enrollment: { pinned: label } } });
      const text = JSON.stringify(body);
      for (const forbidden of ["march-race", OWNER, "2027-03-2"]) expect(text).not.toContain(forbidden);
    }
    expect(w0Objects(present)).toBe(0);
  });

  it("does not turn an unavailable lookup into a failure", async () => {
    const w = world("2027-01-05T17:00:00.000Z");
    vi.mocked(sourceModule.createRaceMetadataReader).mockImplementationOnce(() => { throw new Error("synthetic"); });
    expect(await (await w.call("?mode=preflight")).json()).toMatchObject({ status: "preflight_ok", checks: { enrollment: { pinned: "unavailable" } } });
  });
});


describe("a full year of unattended cron runs", () => {
  it("captures March and September (four each), keeps idle days storage-free, and bounds discovery reads", async () => {
    const w = world("2027-01-01T13:00:00.000Z");
    const septDue = new Set(["2027-08-07", "2027-08-21", "2027-08-28", "2027-09-03"]);
    const marchDue = new Set(["2027-02-20", "2027-03-06", "2027-03-13", "2027-03-19"]);
    let idleCalls = 0;
    for (let day = 0; day < 365; day++) {
      for (const hour of [13, 17, 21]) {
        const iso = new Date(Date.UTC(2027, 0, 1 + day, hour)).toISOString();
        const date = iso.slice(0, 10);
        w.set(iso);
        // The owner activates the September race on April 1 and never touches env or crons again.
        reader.active = date >= "2027-04-01" ? { races: [half("sept", "2027-09-04")], overflow: false } : { races: [], overflow: false };
        const before = w.gcs.calls.length;
        const body = await (await w.call()).json();
        if (!marchDue.has(date) && !septDue.has(date)) {
          expect(body.status).toBe("idle");
          idleCalls += w.gcs.calls.length - before;
        }
      }
    }
    expect(idleCalls).toBe(0);
    expect(w.gcs.objects.size).toBe(8);
    expect(reader.activeCalls).toBe(365 * 3);
    expect(w.clients.disposed).toBe(w.clients.opened);
    const now = "2027-12-31T00:00:00.000Z";
    const audits = await auditEnrolledCaptures([{ target: pilotTarget("synthetic", "march-race") },
      { target: { subject: "synthetic", raceId: "sept", raceDate: "2027-09-04", timeZone: "America/New_York" }, options: { enrolledFrom: "2027-04-01T00:00:00.000Z" } }],
      now, verifier(w));
    expect(audits.healthy).toBe(true);
    expect(audits.reports.map(r => r.report.rows.map(row => row.status))).toEqual([Array(4).fill("verified"), Array(4).fill("verified")]);
    // March evidence is unchanged by September's existence: same objects, same original generations.
    expect(audits.reports[0].report.custody).toHaveLength(4);
  }, 120_000);
});

describe("audit across enrolled races", () => {
  it("separates not-enrolled, canceled, missed and pending slots and keeps races independent", async () => {
    const sept = { subject: "synthetic", raceId: "sept", raceDate: "2027-09-04", timeZone: "America/New_York" };
    const store = { read: async () => null };
    const now = "2027-08-30T12:00:00.000Z"; // 28d and 14d slots are over; 7d (Aug 28) is over; 1d (Sep 3) not due
    const strict = await auditCaptures(sept, now, store);
    expect(strict.rows.map(r => r.status)).toEqual(["missed", "missed", "missed", "not_due"]);
    expect(strict.healthy).toBe(false);
    const late = await auditCaptures(sept, now, store, { enrolledFrom: "2027-08-25T17:00:00.000Z" });
    expect(late.rows.map(r => r.status)).toEqual(["not_enrolled", "not_enrolled", "missed", "not_due"]);
    const canceled = await auditCaptures(sept, now, store, { enrolledFrom: "2027-08-01T00:00:00.000Z", canceledAt: "2027-08-25T17:00:00.000Z" });
    expect(canceled.rows.map(r => r.status)).toEqual(["missed", "missed", "canceled", "canceled"]);
    const both = await auditEnrolledCaptures([{ target: sept }, { target: pilotTarget("synthetic", "march-race") }], now, store);
    expect(both.reports).toHaveLength(2);
    expect(both.healthy).toBe(false);
  });
});

function w0Objects(w: { gcs: { objects: Map<string, unknown> } }) { return w.gcs.objects.size; }
