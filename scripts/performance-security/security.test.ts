/** @vitest-environment node */
import { beforeAll, describe, expect, it } from "vitest";

// This suite can only target an explicitly enabled loopback demo emulator.
const enabled = process.env.PERFORMANCE_SECURITY_EMULATOR === "1";
const project = "demo-training-performance";
const host = "127.0.0.1:8187";
const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const ownerUid = "performance-owner";
const ownerEmail = "folstromjohn@gmail.com";
function token(uid = ownerUid, email = ownerEmail, verified = true) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: uid, user_id: uid, email, email_verified: verified, aud: project, iss: `https://securetoken.google.com/${project}`, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, firebase: { sign_in_provider: "custom", identities: {} } })}.`;
}
function value(input: unknown): unknown {
  if (input === null) return { nullValue: null };
  if (typeof input === "string") return { stringValue: input };
  if (typeof input === "boolean") return { booleanValue: input };
  if (typeof input === "number") return { integerValue: String(input) };
  if (Array.isArray(input)) return { arrayValue: { values: input.map(value) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, item]) => [key, value(item)])) } };
}
const fields = (input: object) => Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)]));
async function read(path: string, auth: string | null = token()) {
  return fetch(`${base}/${path}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
}
async function commit(records: { path: string; data?: object; remove?: boolean; timestamp?: boolean }[], auth: string | null = token()) {
  const writes = records.map(record => record.remove ? { delete: `${base.split("http://" + host + "/v1/")[1]}/${record.path}` } : {
    update: { name: `projects/${project}/databases/(default)/documents/${record.path}`, fields: fields(record.data!) },
    ...(record.timestamp ? { updateTransforms: [{ fieldPath: "committedAt", setToServerValue: "REQUEST_TIME" }] } : {}),
  });
  return fetch(`${base}:commit`, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ writes }) });
}
const prefix = `users/${ownerUid}`;
const currentPath = `${prefix}/performanceState/current`;
const digest = (character: string) => character.repeat(64);
const publication = (id = "a", revision = 1, previousSnapshotId: string | null = null) => ({
  schemaVersion: 1, revision, snapshotId: digest(id), previousSnapshotId, publicationDigest: digest(id), committedAt: null,
  featureRevisions: [], payload: {
    result: { evidenceDigest: digest("e"), asOf: "2026-10-21T14:00:00.000Z", versions: { schema: 1, model: "manual-performance-v1", extractor: "v1", qualityPolicy: "v1" }, capability: { distance: "half_marathon", status: "unavailable", reason: "no_validated_estimator", estimatedSeconds: null, confidenceInterval: null } },
    evidenceDigest: digest("e"), versions: { schema: 1, model: "manual-performance-v1", extractor: "v1", qualityPolicy: "v1" },
    reason: "analyze_new_workouts", historyBasis: "actual_calculation", calculationStartedAt: "2026-10-21T14:00:00.000Z", calculationCompletedAt: "2026-10-21T14:00:01.000Z", evidenceAsOf: "2026-10-21T14:00:00.000Z", provenance: [], coverage: {},
  },
});
const pair = (data: ReturnType<typeof publication>) => [{ path: currentPath, data, timestamp: true }, { path: `${prefix}/performanceSnapshots/${data.snapshotId}`, data, timestamp: true }];
const feature = {
  schemaVersion: 1, workoutId: "run-a", revision: 1, featureDigest: digest("a"),
  feature: { workoutId: "run-a", parentDigest: digest("b"), sourceInputDigest: digest("c"), telemetryDigest: null, telemetryState: "absent", qualityPolicyDigest: digest("d"), extractorVersion: "v1", qualityPolicyVersion: "v1", extractedAt: "2026-10-21T14:00:00.000Z", observedAt: "2026-10-18T14:00:00.000Z", status: "rejected", completion: "completed", quality: {}, provenance: {}, observations: [], reasons: [], limitations: [] },
  workout: { workoutId: "run-a", parentDigest: digest("b"), telemetry: { contentDigest: null, state: "absent" }, startedAt: "2026-10-18T12:00:00.000Z", endedAt: "2026-10-18T12:30:00.000Z", availableAt: null, completion: "completed", excluded: false, isRun: true, runKind: "outdoor", distanceMeters: 5400, durationSeconds: 1800, averageHrBpm: 142, ascentMeters: null, environment: {}, provenance: {}, limitations: [] },
};

describe.skipIf(!enabled)("isolated owner performance security rules", () => {
  beforeAll(async () => {
    if (process.env.FIRESTORE_EMULATOR_HOST !== host || !project.startsWith("demo-")) throw new Error("Refusing nonisolated emulator target");
    const response = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Cannot reset isolated demo emulator: ${await response.text()}`);
  });
  it("permits the pinned verified owner to create and read compact feature records", async () => {
    const response = await commit([{ path: `${prefix}/performanceFeatures/run-a`, data: feature }]);
    expect(await response.text()).toBeTruthy(); expect(response.status).toBe(200);
    expect((await read(`${prefix}/performanceFeatures/run-a`)).status).toBe(200);
  });
  it("denies unauthenticated, unrelated authenticated, unverified and other-path access", async () => {
    for (const auth of [null, token("stranger", "stranger@example.com"), token(ownerUid, ownerEmail, false)]) {
      expect((await read(`${prefix}/performanceFeatures/run-a`, auth)).status).toBe(403);
      expect((await commit([{ path: `${prefix}/performanceFeatures/other`, data: { ...feature, workoutId: "other" } }], auth)).status).toBe(403);
      expect((await read(currentPath, auth)).status).toBe(403);
      expect((await read(`${prefix}/performanceSnapshots/${digest("a")}`, auth)).status).toBe(403);
    }
    expect((await read(`users/stranger/performanceState/current`)).status).toBe(403);
    expect((await read(currentPath, token("other-uid", ownerEmail))).status).toBe(403);
  });
  it("rejects a feature revision overwrite and unexpected raw-stream fields", async () => {
    expect((await commit([{ path: `${prefix}/performanceFeatures/run-a`, data: feature }])).status).toBe(403);
    expect((await commit([{ path: `${prefix}/performanceFeatures/raw`, data: { ...feature, rawGps: [1, 2, 3] } }])).status).toBe(403);
  });
  it("rejects creating current or a snapshot without its atomic matching partner", async () => {
    expect((await commit([{ path: currentPath, data: publication(), timestamp: true }])).status).toBe(403);
    expect((await commit([{ path: `${prefix}/performanceSnapshots/${digest("a")}`, data: publication(), timestamp: true }])).status).toBe(403);
    expect((await read(currentPath)).status).toBe(404);
  });
  it("accepts a matching current+snapshot pair with a server commit timestamp", async () => {
    const response = await commit(pair(publication()));
    const body = await response.text(); expect(body, body).toBeTruthy(); expect(response.status, body).toBe(200);
    expect((await read(currentPath)).status).toBe(200);
    expect((await read(`${prefix}/performanceSnapshots/${digest("a")}`)).status).toBe(200);
  });
  it("denies snapshot updates and deletes even to the verified owner", async () => {
    expect((await commit([{ path: `${prefix}/performanceSnapshots/${digest("a")}`, data: publication(), timestamp: true }])).status).toBe(403);
    expect((await commit([{ path: `${prefix}/performanceSnapshots/${digest("a")}`, remove: true }])).status).toBe(403);
  });
  it("denies unrelated users' current/snapshot mutations", async () => {
    const stranger = token("stranger", "stranger@example.com");
    expect((await commit(pair(publication("b", 2, digest("a"))), stranger)).status).toBe(403);
    expect((await commit([{ path: `${prefix}/performanceSnapshots/${digest("a")}`, remove: true }], stranger)).status).toBe(403);
  });
  it("rejects stale revision, mismatched atomic pair, and a fabricated numerical estimate", async () => {
    expect((await commit(pair(publication("b", 1)))).status).toBe(403);
    const mismatch = pair(publication("b", 2, digest("a"))); mismatch[1].data = publication("c", 2, digest("a"));
    expect((await commit(mismatch)).status).toBe(403);
    const fabricated = publication("b", 2, digest("a"));
    (fabricated.payload.result.capability as { estimatedSeconds: number | null }).estimatedSeconds = 7200;
    expect((await commit(pair(fabricated))).status).toBe(403);
  });
  it("allows a second actual calculation on the same date, preserving immutable prior snapshot", async () => {
    const response = await commit(pair(publication("b", 2, digest("a"))));
    const body = await response.text(); expect(response.status, body).toBe(200);
    expect((await read(`${prefix}/performanceSnapshots/${digest("a")}`)).status).toBe(200);
  });
});
