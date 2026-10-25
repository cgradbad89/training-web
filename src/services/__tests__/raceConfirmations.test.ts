import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RaceConfirmationDraft } from "@/types/raceConfirmation";
import { buildRaceConfirmationInput } from "@/utils/raceConfirmation";

const h = vi.hoisted(() => ({
  user: null as User | null, records: new Map<string, Record<string, unknown>>(), reads: [] as string[],
  updates: [] as { path: string; fields: Record<string, unknown> }[], token: vi.fn(),
  failBeforeCommit: false, loseAcknowledgement: false, failReadback: false,
  onRead: null as ((path: string) => void) | null,
}));
vi.mock("@/lib/firebase", () => ({ auth: { get currentUser() { return h.user; } }, db: {} }));
vi.mock("firebase/auth", () => ({ getIdTokenResult: (...args: unknown[]) => h.token(...args) }));
vi.mock("firebase/firestore", () => {
  const snapshot = (path: string) => {
    h.reads.push(path); h.onRead?.(path);
    return { id: path.split("/").at(-1), exists: () => h.records.has(path), data: () => h.records.get(path) };
  };
  return {
    doc: (_db: unknown, ...parts: string[]) => parts.join("/"),
    serverTimestamp: () => ({ serverReceipt: true }),
    getDocFromServer: vi.fn(async (path: string) => { if (h.failReadback) throw new Error("readback unavailable"); return snapshot(path); }),
    runTransaction: vi.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const writes: { path: string; fields: Record<string, unknown> }[] = [];
      const result = await fn({ get: async (path: string) => snapshot(path), update: (path: string, fields: Record<string, unknown>) => writes.push({ path, fields }) });
      if (h.failBeforeCommit) throw new Error("permission-denied");
      for (const write of writes) {
        const next = { ...h.records.get(write.path) };
        const oldHistory = next.confirmationHistory as { revisions?: object } | undefined;
        next.confirmationHistory = { ...oldHistory, revisions: { ...oldHistory?.revisions } };
        for (const [field, value] of Object.entries(write.fields)) {
          const parts = field.split("."); let target = next;
          for (const key of parts.slice(0, -1)) target = target[key] as Record<string, unknown>;
          target[parts.at(-1)!] = field.startsWith("confirmationHistory.revisions.")
            ? { ...value as object, availableAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 1 } } : value;
        }
        h.records.set(write.path, next); h.updates.push(write);
      }
      if (h.loseAcknowledgement) { h.loseAcknowledgement = false; throw new Error("commit acknowledgement lost"); }
      return result;
    }),
    collection: vi.fn(), getDocs: vi.fn(), setDoc: vi.fn(), deleteDoc: vi.fn(), updateDoc: vi.fn(), deleteField: vi.fn(), writeBatch: vi.fn(),
  };
});
import { saveRaceConfirmation } from "@/services/raceConfirmations";

const path = (suffix: string) => `users/owner/${suffix}`;
const racePath = path("halfMarathonRaces/synthetic-race");
const workoutPath = path("healthWorkouts/synthetic-run");
const overridePath = path("workoutOverrides/synthetic-run");
let race: Race;
let workout: HealthWorkout;
const draft: RaceConfirmationDraft = { officialEventName: "Synthetic Harbor Half", raceDate: "2026-09-20", distanceMeters: 21097.5, finishSeconds: 7871, timeBasis: "chip", status: "verified", effort: "maximal", conditions: "Flat and cool.", source: "https://example.test/result/synthetic" };
const input = (record = race, changes: Partial<RaceConfirmationDraft> = {}, requestId = "request-one") => buildRaceConfirmationInput({ race: record, workout, override: null, timeZone: "America/New_York", draft: { ...draft, ...changes }, requestId });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
  vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true"); vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
  h.user = { uid: "owner", email: "folstromjohn@gmail.com", emailVerified: true } as User;
  h.token.mockReset().mockResolvedValue({ claims: { sub: "owner", email: "folstromjohn@gmail.com", email_verified: true } });
  h.records.clear(); h.reads = []; h.updates = []; h.failBeforeCommit = false; h.loseAcknowledgement = false; h.failReadback = false; h.onRead = null;
  race = { id: "synthetic-race", name: "Synthetic Harbor Half", raceDate: "2026-09-20", raceDistance: "halfMarathon", actualRunId: "synthetic-run", actualRunDurationSeconds: 7871, isActive: false, createdAt: "2026-09-01T12:00:00.000Z" };
  workout = { workoutId: "synthetic-run", startDate: new Date("2026-09-20T12:00:00.000Z"), endDate: new Date("2026-09-20T14:11:11.000Z"), durationSeconds: 7871, distanceMiles: 13.109, distanceMeters: 21097.5, isRunLike: true, activityType: "running", syncedAt: new Date("2026-09-20T15:00:00.000Z") } as HealthWorkout;
  h.records.set(racePath, { ...race }); h.records.set(workoutPath, { ...workout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("race confirmation authorization and online write boundary", () => {
  it.each(["production"])("performs no reads/writes in %s even when opted in", async deployment => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", deployment);
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("disabled");
    expect(h.reads).toEqual([]); expect(h.updates).toEqual([]); expect(h.token).not.toHaveBeenCalled();
  });
  it("rejects an unset opt-in before starting work", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", undefined);
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("disabled"); expect(h.reads).toEqual([]);
  });
  it.each(["different-uid", "owner/not-a-document"])("rejects an incorrect caller UID %s", async uid => {
    await expect(saveRaceConfirmation(uid, input())).rejects.toThrow("owner session"); expect(h.reads).toEqual([]);
  });
  it("rejects unauthorized/unverified Firebase identities and token claims", async () => {
    h.user = { ...h.user, emailVerified: false } as User;
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("owner session");
    h.user = { ...h.user, emailVerified: true } as User;
    h.token.mockResolvedValue({ claims: { sub: "owner", email: "stranger@example.test", email_verified: true } });
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("owner token"); expect(h.reads).toEqual([]);
  });
  it("rechecks identity after asynchronous reads and submits no retired-session update", async () => {
    h.onRead = () => { h.user = null; };
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("owner session"); expect(h.updates).toEqual([]);
  });
  it("writes only a nested revision on the existing race and retains all parent observations", async () => {
    const originals = JSON.stringify({ race, workout });
    const saved = await saveRaceConfirmation("owner", input());
    expect(h.reads).toEqual([racePath, workoutPath, overridePath, racePath]);
    expect(h.updates).toHaveLength(1); expect(h.updates[0].path).toBe(racePath);
    expect(Object.keys(h.updates[0].fields).every(key => key.startsWith("confirmationHistory."))).toBe(true);
    expect(h.records.get(workoutPath)).toEqual(workout);
    expect(saved.result).toBeUndefined(); expect(saved.actualRunDurationSeconds).toBe(7871);
    expect(JSON.stringify({ race, workout })).toBe(originals);
    expect(saved.confirmationHistory?.chronology).toBe("client_document_untrusted");
    expect(saved.confirmationHistory?.revisions["request-one"].availableAt).toBe("2026-10-25T12:00:00.001Z");
  });
  it("refuses deleted race documents instead of creating a replacement", async () => {
    h.records.delete(racePath);
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("no longer exists"); expect(h.updates).toEqual([]);
  });
  it("rejects changed race, linked parent and override observations without writing", async () => {
    const expected = input();
    h.records.set(racePath, { ...race, result: "2:12:00" });
    await expect(saveRaceConfirmation("owner", expected)).rejects.toThrow("changed");
    h.records.set(racePath, { ...race }); h.records.set(workoutPath, { ...workout, durationSeconds: 7872 });
    await expect(saveRaceConfirmation("owner", expected)).rejects.toThrow("changed");
    h.records.set(workoutPath, { ...workout }); h.records.set(overridePath, { workoutId: workout.workoutId, userId: "owner", isExcluded: false, distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, excludedAt: null, excludedReason: null, updatedAt: "2026-10-25T11:00:00.000Z" });
    await expect(saveRaceConfirmation("owner", expected)).rejects.toThrow("changed"); expect(h.updates).toEqual([]);
  });
  it("rejects invalid existing history rather than erasing it", async () => {
    h.records.set(racePath, { ...race, confirmationHistory: { schemaVersion: 99 } });
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("invalid"); expect(h.updates).toEqual([]);
  });
  it("never publishes a queued write after an offline/permission failure", async () => {
    h.failBeforeCommit = true;
    await expect(saveRaceConfirmation("owner", input())).rejects.toThrow("permission-denied");
    expect(h.records.get(racePath)).toEqual(race); expect(h.updates).toEqual([]);
  });
});

describe("revision concurrency, idempotence and receipt resolution", () => {
  it("retries the exact request after lost acknowledgement without adding a revision", async () => {
    const expected = input(); h.loseAcknowledgement = true;
    await expect(saveRaceConfirmation("owner", expected)).rejects.toThrow("acknowledgement");
    const saved = await saveRaceConfirmation("owner", expected);
    expect(h.updates).toHaveLength(1); expect(Object.keys(saved.confirmationHistory!.revisions)).toHaveLength(1);
  });
  it("supports a retry after receipt read failure without inventing a browser known-at", async () => {
    const expected = input(); h.failReadback = true;
    await expect(saveRaceConfirmation("owner", expected)).rejects.toThrow("readback");
    h.failReadback = false;
    expect((await saveRaceConfirmation("owner", expected)).confirmationHistory?.revisions["request-one"].availableAt).toBe("2026-10-25T12:00:00.001Z");
    expect(h.updates).toHaveLength(1);
  });
  it("rejects reused request IDs with changed payloads", async () => {
    await saveRaceConfirmation("owner", input());
    await expect(saveRaceConfirmation("owner", input(race, { source: "https://example.test/other" }))).rejects.toThrow("different evidence");
    expect(h.updates).toHaveLength(1);
  });
  it("rejects stale revision submissions and unchanged evidence with a new request ID", async () => {
    const saved = await saveRaceConfirmation("owner", input());
    vi.setSystemTime(new Date("2026-10-25T12:00:01.000Z"));
    await expect(saveRaceConfirmation("owner", input(race, { source: "https://example.test/other" }, "request-two"))).rejects.toThrow("changed");
    await expect(saveRaceConfirmation("owner", input(saved, { correctionReason: "Retry same evidence." }, "request-two"))).rejects.toThrow("already confirmed");
    expect(h.updates).toHaveLength(1);
  });
  it("rejects a forged future prior receipt before appending any correction", async () => {
    const saved = await saveRaceConfirmation("owner", input());
    const history = saved.confirmationHistory!;
    history.revisions["request-one"].availableAt = "2026-12-25T12:00:00.000Z";
    h.records.set(racePath, { ...saved, confirmationHistory: history });
    await expect(saveRaceConfirmation("owner", input(saved, { source: "https://example.test/corrected", correctionReason: "Corrected source." }, "request-two"))).rejects.toThrow("future");
    expect(h.updates).toHaveLength(1);
  });
  it("appends a reasoned correction while preserving previous receipt timestamps and original data", async () => {
    const saved = await saveRaceConfirmation("owner", input());
    const old = (h.records.get(racePath)!.confirmationHistory as { revisions: Record<string, unknown> }).revisions["request-one"];
    vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
    const corrected = await saveRaceConfirmation("owner", input(saved, { source: "https://example.test/corrected", correctionReason: "Corrected official result link." }, "request-two"));
    expect(corrected.confirmationHistory?.currentRevisionId).toBe("request-two");
    expect(corrected.confirmationHistory?.revisions["request-two"].availableAt).toBe("2026-10-26T12:00:00.001Z");
    expect((h.records.get(racePath)!.confirmationHistory as { revisions: Record<string, unknown> }).revisions["request-one"]).toEqual(old);
    expect(h.records.get(workoutPath)).toEqual(workout);
  });
});
