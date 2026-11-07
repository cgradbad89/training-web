/**
 * Phase 3J — bounded, dry-run-first recovery of MISSING historical weather.
 *
 * The in-app runner (src/components/WeatherBackfillRunner.tsx) automatically
 * covers the last WEATHER_AUTO_LOOKBACK_DAYS days. This script is the explicit,
 * owner-run path for older history. It is NOT wired to any trigger and is never
 * run by CI or by agents against production.
 *
 * Guarantees:
 *  - DRY-RUN by default: reads workout PARENT documents only and prints the plan
 *    (counts + cost estimate); writes nothing and calls no weather API.
 *  - COMMIT is explicit and bounded: at most RECOVER_MAX workouts (default 25,
 *    hard cap 200), newest-first, spaced, stopping on the first HTTP 429.
 *  - Never overwrites: each write is a transaction that skips any workout that
 *    already has `weather`, so historical `fetchedAt` evidence is preserved.
 *    New snapshots carry their true retrieval time (`fetchedAt` = now) — a
 *    recovered snapshot is never back-dated, so replays as-of earlier dates
 *    correctly ignore it.
 *  - Reads at most one route document (the first point) per attempted workout.
 *    No GPS track, HR stream, or health-metric reads. Output has no coordinates.
 *
 * Usage (Firebase admin credential in .env.local, same as repairHasRoute):
 *   Dry-run:  RECOVER=1      npx vitest run scripts/recoverWeather.test.ts
 *   Commit:   RECOVER=commit RECOVER_MAX=25 npx vitest run scripts/recoverWeather.test.ts
 */
import { readFileSync } from "node:fs";
import admin from "firebase-admin";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WeatherSnapshot } from "@/types/weather";
import type { WeatherFetchResult } from "@/lib/weather";
import {
  WEATHER_CALL_SPACING_MS,
  isUsableStartCoordinate,
  planWeatherRecovery,
  selectWeatherCandidates,
  type WeatherRecoveryPlan,
} from "@/utils/weatherBackfill";

export const RECOVER_DEFAULT_MAX = 25;
export const RECOVER_HARD_MAX = 200;
/** Parent-document field mask: nothing here is location or physiology detail. */
export const RECOVER_FIELDS = [
  "isRunLike", "hasRoute", "displayType", "startDate", "endDate", "entrySource", "weather",
] as const;

export interface RecoveryDeps {
  loadWorkouts: () => Promise<HealthWorkout[]>;
  getStartPoint: (workoutId: string) => Promise<{ lat: number; lng: number } | null>;
  fetchWeather: (lat: number, lng: number, start: Date) => Promise<WeatherFetchResult>;
  saveIfAbsent: (workoutId: string, weather: WeatherSnapshot) => Promise<"saved" | "preserved" | "missing">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface RecoveryOptions {
  commit: boolean;
  max?: number;
}

export interface RecoveryReport {
  mode: "DRY-RUN" | "COMMIT";
  plan: WeatherRecoveryPlan;
  cap: number;
  attempted: number;
  saved: number;
  preserved: number;
  noStartPoint: number;
  unavailable: number;
  failed: number;
  stoppedForRateLimit: boolean;
}

export function resolveRecoveryCap(max: number | undefined): number {
  if (max === undefined || !Number.isFinite(max) || max < 1) return RECOVER_DEFAULT_MAX;
  return Math.min(Math.floor(max), RECOVER_HARD_MAX);
}

export async function runWeatherRecovery(deps: RecoveryDeps, options: RecoveryOptions): Promise<RecoveryReport> {
  const workouts = await deps.loadWorkouts();
  const now = deps.now();
  const plan = planWeatherRecovery(workouts, { now });
  const cap = resolveRecoveryCap(options.max);
  const report: RecoveryReport = {
    mode: options.commit ? "COMMIT" : "DRY-RUN", plan, cap,
    attempted: 0, saved: 0, preserved: 0, noStartPoint: 0, unavailable: 0, failed: 0, stoppedForRateLimit: false,
  };
  if (!options.commit) return report;

  const ids = selectWeatherCandidates(workouts, { now, limit: cap, lookbackDays: null });
  const byId = new Map(workouts.map((w) => [w.workoutId, w]));
  for (const id of ids) {
    if (report.attempted > 0) await deps.sleep(WEATHER_CALL_SPACING_MS);
    report.attempted += 1;
    try {
      const start = await deps.getStartPoint(id);
      if (!start || !isUsableStartCoordinate(start.lat, start.lng)) { report.noStartPoint += 1; continue; }
      const result = await deps.fetchWeather(start.lat, start.lng, byId.get(id)!.startDate);
      if (result.status === "rate-limited") { report.stoppedForRateLimit = true; break; }
      if (result.status === "unavailable") { report.unavailable += 1; continue; }
      if (result.status !== "ok") { report.failed += 1; continue; }
      const outcome = await deps.saveIfAbsent(id, result.weather);
      if (outcome === "saved") report.saved += 1;
      else if (outcome === "preserved") report.preserved += 1;
      else report.failed += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}

/* ---------------------------- admin wiring ---------------------------- */

function loadServiceAccount(): Record<string, unknown> {
  const env = readFileSync(".env.local", "utf8");
  const line = env.split("\n").find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env.local");
  let val = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();
  if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) val = val.slice(1, -1);
  return JSON.parse(val);
}

export async function createAdminRecoveryDeps(uidOverride?: string): Promise<RecoveryDeps> {
  const { fetchWeatherForRunDetailed } = await import("@/lib/weather");
  if (!admin.apps.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount() as any) });
  }
  const db = admin.firestore();
  let uid = uidOverride;
  if (!uid) {
    const probe = await db.collectionGroup("healthWorkouts").select().limit(1).get();
    if (probe.empty) throw new Error("No healthWorkouts found; pass RECOVER_UID=<uid>");
    uid = probe.docs[0].ref.path.split("/")[1];
  }
  const owner = uid;
  const toDate = (v: unknown): Date => (v && typeof (v as { toDate?: unknown }).toDate === "function" ? (v as { toDate: () => Date }).toDate() : new Date(NaN));
  return {
    loadWorkouts: async () => {
      const snap = await db.collection(`users/${owner}/healthWorkouts`)
        .where("isRunLike", "==", true).orderBy("startDate", "desc").select(...RECOVER_FIELDS).get();
      return snap.docs.map((d) => {
        const x = d.data();
        return {
          workoutId: d.id, isRunLike: x.isRunLike === true, hasRoute: x.hasRoute === true,
          displayType: x.displayType ?? "", entrySource: x.entrySource, weather: x.weather ?? null,
          startDate: toDate(x.startDate), endDate: toDate(x.endDate),
        } as HealthWorkout;
      });
    },
    getStartPoint: async (id) => {
      const snap = await db.collection(`users/${owner}/healthWorkouts/${id}/route`).orderBy(admin.firestore.FieldPath.documentId()).limit(1).get();
      if (snap.empty) return null;
      const data = snap.docs[0].data();
      return Number.isFinite(data.lat) && Number.isFinite(data.lng) ? { lat: data.lat, lng: data.lng } : null;
    },
    fetchWeather: (lat, lng, start) => fetchWeatherForRunDetailed(lat, lng, start),
    saveIfAbsent: (id, weather) => {
      const ref = db.doc(`users/${owner}/healthWorkouts/${id}`);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return "missing" as const;
        if (snap.data()?.weather != null) return "preserved" as const;
        tx.set(ref, { weather }, { merge: true });
        return "saved" as const;
      });
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
