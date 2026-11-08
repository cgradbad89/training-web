/**
 * April → September 2026 historical case study — READ-ONLY, never run by CI, never writes (Firestore or disk inside the repository).
 *
 * `buildBacktestReport` is PURE and generic (it knows no owner identifiers; races are chosen by id in the config), so it is unit-tested
 * on invented data. The live runner reuses the bounded Phase 3Q–3T loader with a wider workout window, then reads HR-stream chunks ONLY for
 * the runs production hydration would select at some checkpoint (≤16 per checkpoint, ≤40 chunks each, a stream reaching the bound is
 * discarded exactly as in production) and keeps SUMMARIES only. Private captures (`BACKTEST_CACHE`, `BACKTEST_STREAM_CACHE`) must be
 * outside the repository and deleted by the operator.
 *
 *   BACKTEST=1 BACKTEST_OUT=/private/report.json BACKTEST_CACHE=/private/capture.json BACKTEST_STREAM_CACHE=/private/streams.json \
 *     TZ=America/New_York npx vitest run scripts/researchAprilSeptemberBacktest.test.ts
 *
 * No coefficient is fitted to any outcome. Race outcomes are only ever the withheld label.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import admin from "firebase-admin";
import type { HrStreamSummary } from "@/types/hybridPerformance";
import type { Race } from "@/types/race";
import type { EvidenceKindV11 } from "@/types/hybridPerformanceV11";
import { summarizeHrStream } from "@/utils/performance/hrStreamQuality";
import { PHYSIOLOGY_LIMITS } from "@/services/physiologyEvidenceStores";
import { leaveOneOutV11, leaveOneWeekOutV11, sweepsV11 } from "@/utils/research/hybridV11Evaluation";
import {
  buildAsOfState, evaluateCheckpoint, explainChange, holdoutAssessment, localInstant, predictionError,
  type AsOfOptions, type BacktestSource, type CheckpointRow, type OwnerConfirmationSpec, type ReplayMode,
} from "@/utils/research/historicalBacktest";
import { buildRaceEvidence } from "@/utils/racePerformance";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { selectStreamCandidates } from "@/utils/performance/hrStreamSelection";
import { loadFromCache, loadLive, serviceAccount, lastLiveReads, type HybridLoaded } from "./researchHybrid";

export const TZ = "America/New_York";
const hms = (value: number | null) => {
  if (value === null) return null;
  const s = Math.round(value);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const round = (n: number | null | undefined, k = 1) => n == null ? null : Math.round(n * 10 ** k) / 10 ** k;

export type VariantId = "strict_historical" | "reconstruction_as_recorded" | "owner_confirmed_strict" | "owner_confirmed_retro_effort_unattested" | "owner_confirmed_retro"
  | "counterfactual_early_moving_time" | "counterfactual_early_race_excluded" | "hypothetical_best_efforts_current_owner_confirmed";
/** Owner-attested early-race result without the effort attestation (the caller adds it per variant). */
export type OwnerAttestation = Omit<OwnerConfirmationSpec, "effort">;
export const VARIANTS: { id: VariantId; mode: ReplayMode; label: string; options: (earlyRaceId: string | null, owner: OwnerAttestation | null) => AsOfOptions }[] = [
  { id: "strict_historical", mode: "strict_historical", label: "STRICT: records as saved (no confirmation exists in the database)", options: () => ({}) },
  { id: "reconstruction_as_recorded", mode: "retrospective_reconstruction", label: "RECONSTRUCTION: records as saved (early race rejected by integrity rules)", options: () => ({}) },
  { id: "owner_confirmed_strict", mode: "strict_historical", label: "STRICT with the owner-attested official result known only from its real confirmation instant", options: (_, o) => o ? { ownerConfirmation: { ...o, effort: "maximal" } } : {} },
  { id: "owner_confirmed_retro_effort_unattested", mode: "retrospective_reconstruction", label: "RETROSPECTIVE (research only): official time attested, maximal effort NOT attested", options: (_, o) => o ? { ownerConfirmation: { ...o, effort: "unknown" } } : {} },
  { id: "owner_confirmed_retro", mode: "retrospective_reconstruction", label: "RETROSPECTIVE (research only, PRIMARY): official 2:15:30 attested, maximal effort assumed", options: (_, o) => o ? { ownerConfirmation: { ...o, effort: "maximal" } } : {} },
  { id: "counterfactual_early_moving_time", mode: "retrospective_reconstruction", label: "COUNTERFACTUAL (previous method): early race accepted via the recorded moving-time clock", options: id => id ? { raceClock: { raceId: id, basis: "moving_time" } } : {} },
  { id: "counterfactual_early_race_excluded", mode: "retrospective_reconstruction", label: "COUNTERFACTUAL (research only): early race outcome removed from evidence entirely", options: id => id ? { excludeRaceIds: [id] } : {} },
  { id: "hypothetical_best_efforts_current_owner_confirmed", mode: "retrospective_reconstruction", label: "HYPOTHETICAL (research only): owner-confirmed April AND stale best-effort summaries treated as current", options: (_, o) => ({ relabelBestEffortsCurrent: true, ...(o ? { ownerConfirmation: { ...o, effort: "maximal" as const } } : {}) }) },
];

export interface Checkpoint { label: string; asOf: string; required: boolean }
export interface BacktestConfig {
  earlyRaceId: string | null;
  targetRaceId: string | null;
  /** Withheld outcome labels, seconds. Never visible to any prediction. */
  outcomes: { early: { official: number | null; moving: number | null; elapsed: number | null }; target: number | null };
  /** Owner-attested official early-race result (research only). Null = none supplied. */
  owner: OwnerAttestation | null;
  checkpoints: readonly Checkpoint[];
  /** Instant at which the early race's linked workout became available in the database (reconstruction anchor). */
  earlyRaceAvailableAt: string | null;
}

/** Required + weekly checkpoints, all as valid local instants. `localTime` defaults to a 06:00 prediction. */
export function defaultCheckpoints(args: { preRaceInstant: string; earlyRaceDate: string; targetRaceDate: string; earlyAvailableAt: string | null; localTime?: string; extraDates?: readonly string[] }): Checkpoint[] {
  const t = args.localTime ?? "06:00";
  const at = (date: string, label: string, required: boolean, time = t): Checkpoint => ({ label, asOf: localInstant(date, time, TZ), required });
  const list: Checkpoint[] = [
    at("2026-03-01", "pre-early-race lead 8 wk", false), at("2026-03-29", "pre-early-race lead 4 wk", false), at("2026-04-12", "pre-early-race lead 2 wk", false),
    at(args.earlyRaceDate, "immediately before the early race", true, "05:00"),
  ];
  if (args.earlyAvailableAt) list.push({ label: "after the early race became available", asOf: new Date(Date.parse(args.earlyAvailableAt) + 60_000).toISOString(), required: true });
  const fixed: [string, string][] = [["2026-05-01", "May 1"], ["2026-06-01", "June 1"], ["2026-07-01", "July 1"], ["2026-07-13", "July 13"], ["2026-07-20", "July 20"], ["2026-07-27", "July 27"], ["2026-08-01", "August 1"], ["2026-08-15", "August 15"], ["2026-09-01", "September 1"], ["2026-09-13", "September 13"], ["2026-09-19", "September 19"]];
  for (const [d, l] of fixed) list.push(at(d, l, true));
  for (let d = "2026-05-04"; d <= "2026-09-14"; d = shiftPerformanceDate(d, 7)) if (!fixed.some(([f]) => f === d)) list.push(at(d, `weekly ${d}`, false));
  for (const d of args.extraDates ?? []) if (!list.some(c => c.asOf === localInstant(d, t, TZ))) list.push(at(d, `daily ${d}`, false));
  list.push({ label: "race morning (last valid pre-race instant)", asOf: args.preRaceInstant, required: true });
  return list.sort((a, b) => a.asOf.localeCompare(b.asOf));
}

export interface BacktestInputs { source: BacktestSource; streamSummaries: Record<string, HrStreamSummary> }

/** Which runs production hydration would read HR streams for at each checkpoint/variant (identifiers stay private to the runner). */
export function streamCandidateIds(source: BacktestSource, cfg: BacktestConfig): string[] {
  const ids = new Set<string>();
  for (const cp of cfg.checkpoints) for (const v of VARIANTS) {
    if (v.mode === "strict_historical") continue;
    const state = buildAsOfState(source, cp.asOf, v.mode, v.options(cfg.earlyRaceId, cfg.owner));
    const { runs } = selectResearchRuns({ ...state.input, overrides: state.input.overrides, capturedAt: cp.asOf, source: "owner_parent_export",
      complete: { workouts: true, races: true, overrides: true }, allowSummaryPaceTransfer: false }, true);
    const sel = selectStreamCandidates({ runs, raceWorkoutIds: new Set(state.input.races.flatMap(r => r.actualRunId ? [r.actualRunId] : [])), asOfDate: performanceLocalDate(cp.asOf, TZ) });
    for (const c of sel.candidates) ids.add(c.workoutId);
  }
  return [...ids];
}

const lite = (r: CheckpointRow) => ({
  official: { ...r.official, time: hms(r.official.seconds) }, hrEnhanced: { seconds: r.hrEnhanced.seconds, time: hms(r.hrEnhanced.seconds) },
  hybridV1: { ...r.hybridV1, time: hms(r.hybridV1.seconds) }, hybridV11: { ...r.hybridV11, time: hms(r.hybridV11.seconds), evidenceBaseTime: hms(r.hybridV11.evidenceBaseSeconds) },
  forecast: r.forecast && { ...r.forecast, time: hms(r.forecast.seconds) }, diagnostics: r.diagnostics, raceEvidence: r.raceEvidence, provenance: r.provenance,
});

export function buildBacktestReport({ source, streamSummaries }: BacktestInputs, cfg: BacktestConfig, generatedAt: string) {
  const early = cfg.earlyRaceId ? source.races.find(r => r.id === cfg.earlyRaceId) ?? null : null;
  const target = cfg.targetRaceId ? source.races.find(r => r.id === cfg.targetRaceId) ?? null : null;
  const timeline = cfg.checkpoints.map(cp => {
    const variants: Record<string, ReturnType<typeof lite>> = {};
    const raw: Partial<Record<VariantId, CheckpointRow>> = {};
    for (const v of VARIANTS) {
      const state = buildAsOfState(source, cp.asOf, v.mode, v.options(cfg.earlyRaceId, cfg.owner));
      const row = evaluateCheckpoint(state, source, { streamSummaries, forecastRaceId: cfg.targetRaceId ?? undefined });
      raw[v.id] = row; variants[v.id] = lite(row);
    }
    return { label: cp.label, required: cp.required, asOf: cp.asOf, asOfDate: performanceLocalDate(cp.asOf, TZ), variants, raw };
  });
  // Explanations compare consecutive checkpoints within each variant (reconstruction variants only; strict rows are mostly unavailable).
  const explained = timeline.map((t, i) => ({
    label: t.label, asOfDate: t.asOfDate,
    reasons: Object.fromEntries(VARIANTS.map(v => [v.id, explainChange(i ? timeline[i - 1].raw[v.id]! : null, t.raw[v.id]!)])),
  }));

  const preRace = timeline.at(-1)!;
  const targetActual = cfg.outcomes.target;
  const errorsAt = (row: CheckpointRow, actual: number | null) => ({
    official_v2: predictionError(row.official.seconds, actual), hr_enhanced_v1: predictionError(row.hrEnhanced.seconds, actual),
    hybrid_v1: predictionError(row.hybridV1.seconds, actual), hybrid_v11: predictionError(row.hybridV11.seconds, actual),
    forecast_v2: row.forecast ? predictionError(row.forecast.seconds, actual) : null,
  });
  const holdout = Object.fromEntries(VARIANTS.map(v => [v.id, { asOf: preRace.asOf, predictedAndError: errorsAt(preRace.raw[v.id]!, targetActual) }]));

  // Early-race independent test: the latest checkpoint strictly before the early race.
  const beforeEarly = early ? timeline.filter(t => t.asOf <= localInstant(early.raceDate, "05:30", TZ)).at(-1) : undefined;
  const earlyHoldout = early && beforeEarly ? Object.fromEntries(VARIANTS.map(v => [v.id, {
    asOf: beforeEarly.asOf, errorVsOfficial: errorsAt(beforeEarly.raw[v.id]!, cfg.outcomes.early.official) }])) : null;

  // Sensitivity: research-only scenarios at the last valid pre-race instant, on two bases. The production-as-saved base has no
  // available estimate when the early race is rejected, so each scenario is also run with that race accepted (labelled counterfactual).
  const bases: { id: string; label: string; opts: AsOfOptions }[] = [
    { id: "as_saved", label: "records as saved (production rules)", opts: {} },
    ...(cfg.owner ? [{ id: "owner_confirmed_retro", label: "RETROSPECTIVE (research only): owner-attested official result, maximal effort assumed", opts: { ownerConfirmation: { ...cfg.owner, effort: "maximal" as const } } }] : []),
  ];
  const scenarioDefs: { label: string; opts: AsOfOptions; extra?: { noVo2?: boolean; noStreams?: boolean; excludeKinds?: string[] } }[] = [
    { label: "baseline", opts: {} },
    { label: "early race excluded from evidence", opts: { excludeRaceIds: cfg.earlyRaceId ? [cfg.earlyRaceId] : [] } },
    { label: "no recent performance evidence (race only)", opts: {}, extra: { excludeKinds: ["whole_run_effort", "sustained_segment", "labelled_race_run"] } },
    { label: "no sustained-segment evidence", opts: {}, extra: { excludeKinds: ["sustained_segment"] } },
    { label: "no HR-stream summaries (whole-workout HR only)", opts: {}, extra: { noStreams: true } },
    { label: "no VO₂ readings", opts: {}, extra: { noVo2: true } },
    { label: "no weather (all snapshots stripped)", opts: { stripWeather: true } },
    { label: "no best-effort summaries", opts: { stripBestEfforts: true } },
    { label: "best-effort summaries treated as current (hypothetical)", opts: { relabelBestEffortsCurrent: true } },
    { label: "no overrides applied", opts: { dropAllOverrides: true } },
    { label: "ordinary-run stop time ignored in the timing screen (hypothetical)", opts: { alignElapsedToMovingForOrdinaryRuns: true } },
    { label: "…and weather stripped, so the heat screen cannot apply (hypothetical)", opts: { alignElapsedToMovingForOrdinaryRuns: true, stripWeather: true } },
  ];
  const evalScenario = (opts: AsOfOptions, extra: { noVo2?: boolean; noStreams?: boolean; excludeKinds?: string[] } = {}) => {
    const st = buildAsOfState(source, preRace.asOf, "retrospective_reconstruction", opts);
    return evaluateCheckpoint(st, source, { streamSummaries, noVo2: extra.noVo2, noStreams: extra.noStreams,
      v11Options: extra.excludeKinds ? { combinationParams: { excludeKinds: extra.excludeKinds as EvidenceKindV11[] } } : undefined });
  };
  const sensBases = bases.map(base => {
    const merge = (o: AsOfOptions): AsOfOptions => ({ ...base.opts, ...o });
    const ref = evalScenario(base.opts);
    const rows = scenarioDefs.map(def => {
      const row = evalScenario(merge(def.opts), def.extra);
      const v = row.hybridV11.seconds;
      return { label: def.label, v11Seconds: v, v11Time: hms(v), errorV11: predictionError(v, targetActual), deltaVsBaseSeconds: v !== null && ref.hybridV11.seconds !== null ? round(v - ref.hybridV11.seconds) : null,
        officialSeconds: row.official.seconds, cause: row.hybridV11.cause };
    });
    const st = buildAsOfState(source, preRace.asOf, "retrospective_reconstruction", base.opts);
    const extra = { vo2Entries: st.vo2Entries, streamSummaries };
    return { id: base.id, label: base.label, rows, available: ref.hybridV11.seconds !== null,
      leaveOneRunOut: leaveOneOutV11(st.input, extra), leaveOneWeekOut: leaveOneWeekOutV11(st.input, extra, 8), assumptionSweeps: sweepsV11(st.input, extra) };
  });
  const sens = { asOf: preRace.asOf, bases: sensBases };

  // The forecast is withheld on race day, so its last valid value is the latest earlier checkpoint.
  const lastForecast = Object.fromEntries(VARIANTS.map(v => {
    const t = [...timeline].reverse().find(x => x.raw[v.id]!.forecast?.seconds != null);
    const f = t?.raw[v.id]!.forecast;
    return [v.id, t && f ? { asOf: t.asOf, seconds: f.seconds, time: hms(f.seconds), error: predictionError(f.seconds, targetActual), planStateProvable: f.planStateProvable } : null];
  }));

  // Race integrity (current rules as of generation, and production-historical rules the day before each race).
  const integrity = [early, target].flatMap(r => {
    if (!r) return [];
    const today = buildRaceEvidence({ races: source.races, workouts: source.workouts, overrides: source.overrides, asOf: generatedAt, timeZone: TZ, asOfMode: "current" }).find(e => e.raceId === r.id);
    const eve = buildRaceEvidence({ races: source.races, workouts: source.workouts, overrides: source.overrides, asOf: `${shiftPerformanceDate(r.raceDate, 1)}T12:00:00.000Z`, timeZone: TZ, asOfMode: "historical" }).find(e => e.raceId === r.id);
    const w = source.workouts.find(x => x.workoutId === r.actualRunId);
    const overlapping = w ? source.workouts.filter(x => x.workoutId !== w.workoutId && x.isRunLike && x.startDate < w.endDate && x.endDate > w.startDate).length : 0;
    return [{ race: r.id === cfg.earlyRaceId ? "early" : "target", name: r.name, raceDate: r.raceDate, hasConfirmation: !!(r.performanceEvidence || r.confirmationHistory), hasEnteredResult: !!r.result,
      linkedWorkoutPresent: !!w, recordedDurationSeconds: round(w?.durationSeconds ?? null), elapsedSeconds: w ? round((w.endDate.getTime() - w.startDate.getTime()) / 1000) : null,
      copiedDurationSeconds: round(r.actualRunDurationSeconds ?? null), recordedDistanceMeters: round(w?.distanceMeters ?? null), overlappingRunRecords: overlapping,
      linkedWorkoutSyncedAt: w?.syncedAt.toISOString() ?? null, raceRecordCreatedAt: r.createdAt,
      currentRules: today && { status: today.status, tier: today.tier, timingAgreement: today.timingAgreement, reasons: today.reasons, eligibleForEquivalence: today.eligibleForEquivalence },
      productionHistoricalRulesDayAfter: eve && { status: eve.status, availableAsOf: eve.availableAsOf, reasons: eve.reasons } }];
  });

  // What the production (strict) rules say once the owner-attested result is actually known: available only from its real instant.
  const strictAfterConfirmation = cfg.owner ? (["maximal", "unknown"] as const).map(effort => {
    const st = buildAsOfState(source, generatedAt, "strict_historical", { ownerConfirmation: { ...cfg.owner!, effort } });
    const row = evaluateCheckpoint(st, source, {});
    return { effortAttested: effort, asOf: generatedAt, official: row.official.seconds, officialTime: hms(row.official.seconds), v1: hms(row.hybridV1.seconds), v11: hms(row.hybridV11.seconds), v11Cause: row.hybridV11.cause,
      raceEvidence: row.raceEvidence.filter(e => e.raceDate === early?.raceDate) };
  }) : [];

  const outcomes = [
    ...(early ? [{ raceDate: early.raceDate, qualified: false, reasons: cfg.owner
      ? ["the official time is an owner attestation only: no official-timing source was supplied or checked", "maximal effort and conditions are not attested", "the attestation was made after the race and after the whole evaluation period"]
      : ["recorded clocks disagree (moving vs elapsed) and no official result or owner confirmation exists", "no maximal-effort or conditions confirmation"] }] : []),
    ...(target ? [{ raceDate: target.raceDate, qualified: false, reasons: ["no official result or owner confirmation exists", "maximal effort and conditions unconfirmed", "its pre-race evidence depends on an unqualified early race"] }] : []),
  ];

  // Stale/expiry timeline of the early race under the official estimator and v1.1.
  const stale = (variant: VariantId) => ({
    officialAnchorFirstStaleAt: timeline.find(t => (t.raw[variant]!.official.anchorAgeDays ?? 0) > 90)?.asOfDate ?? null,
    officialAnchorLastUsableAt: timeline.filter(t => t.raw[variant]!.official.seconds !== null).at(-1)?.asOfDate ?? null,
    v11RaceShareFirstBelowHalfAt: timeline.find(t => t.raw[variant]!.hybridV11.seconds !== null && t.raw[variant]!.hybridV11.raceShare < 0.5)?.asOfDate ?? null,
    v11FirstAvailableAt: timeline.find(t => t.raw[variant]!.hybridV11.seconds !== null)?.asOfDate ?? null,
  });

  return {
    generatedAt, timeZone: TZ,
    labels: "Read-only historical case study. Rows labelled strict_historical use only timestamp-proven availability; rows labelled retrospective_reconstruction are NOT predictions that existed at the time; rows labelled counterfactual are hypothetical sensitivity scenarios. Nothing was written; no coefficient was fitted to any race outcome.",
    variants: VARIANTS.map(v => ({ id: v.id, mode: v.mode, label: v.label })),
    outcomes: { early: { officialSeconds: cfg.outcomes.early.official, movingSeconds: cfg.outcomes.early.moving, elapsedSeconds: cfg.outcomes.early.elapsed }, target: { seconds: targetActual, time: hms(targetActual) }, convention: "prediction error = predicted − actual (positive = predicted slower)" },
    raceIntegrity: integrity,
    timeline: timeline.map(t => ({ label: t.label, required: t.required, asOf: t.asOf, asOfDate: t.asOfDate, variants: t.variants })),
    changeExplanations: explained,
    staleness: Object.fromEntries(VARIANTS.map(v => [v.id, stale(v.id)])),
    earlyRaceHoldout: earlyHoldout, targetRaceHoldout: holdout, lastValidForecastBeforeTarget: lastForecast, strictAfterConfirmation,
    sensitivity: sens,
    calibration: holdoutAssessment(outcomes),
    streams: { runsWithSummary: Object.keys(streamSummaries).length },
  };
}

// ─── live runner ─────────────────────────────────────────────────────────────

export interface StreamReads { summaries: Record<string, HrStreamSummary>; chunkReads: number; truncated: number; failed: number; runs: number }

export async function loadStreamSummaries(ids: readonly string[], cachePath?: string): Promise<StreamReads> {
  if (cachePath && existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as StreamReads;
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount() as admin.ServiceAccount) });
  const db = admin.firestore();
  const probe = await db.collectionGroup("healthWorkouts").select().limit(1).get();
  const owner = db.collection("users").doc(probe.docs[0].ref.path.split("/")[1]);
  const L = PHYSIOLOGY_LIMITS;
  const summaries: Record<string, HrStreamSummary> = {};
  let chunkReads = 1, truncated = 0, failed = 0;
  for (const id of ids) {
    try {
      const snap = await owner.collection("healthWorkouts").doc(id).collection("hrStream").orderBy("chunkIndex", "asc").limit(L.maxChunksPerRun).get();
      chunkReads += snap.size;
      if (snap.size >= L.maxChunksPerRun) { truncated++; summaries[id] = { ...summarizeHrStream([]), flags: ["stream_truncated_by_read_bound"] }; continue; }
      const raw: { ms: number; bpm: number }[] = [];
      for (const d of snap.docs) for (const s of ((d.data().samples as { t?: { toDate: () => Date }; hr?: number }[]) ?? [])) {
        const t = s.t?.toDate?.().getTime(); if (t !== undefined && typeof s.hr === "number") raw.push({ ms: t, bpm: s.hr });
      }
      const base = raw.length ? Math.min(...raw.map(r => r.ms)) : 0;
      summaries[id] = summarizeHrStream(raw.map(r => ({ t: (r.ms - base) / 1000, bpm: r.bpm })));
    } catch { failed++; }
  }
  const out: StreamReads = { summaries, chunkReads, truncated, failed, runs: ids.length };
  if (cachePath) writeFileSync(cachePath, JSON.stringify(out));
  return out;
}

const sourceOf = (d: HybridLoaded): BacktestSource => ({ races: d.races, workouts: d.workouts, overrides: d.overrides, plans: d.plans, vo2: d.vo2, timeZone: TZ });

/** Race roles are resolved by raceDate so no owner identifier lives in the repository. */
export function resolveRaces(races: readonly Race[], earlyDate: string, targetDate: string) {
  const early = races.find(r => r.raceDate === earlyDate && r.raceDistance === "halfMarathon") ?? null;
  const target = races.find(r => r.raceDate === targetDate && r.raceDistance === "halfMarathon") ?? null;
  return { early, target };
}

export async function runBacktest(opts: { cachePath?: string; saveCache?: string; streamCache?: string; earlyDate: string; targetDate: string; generatedAt: string; earlyOfficialSeconds?: number; dailyDates?: readonly string[] }) {
  const data = opts.cachePath ? loadFromCache(opts.cachePath) : await loadLive(opts.saveCache, { workoutsFrom: "2025-06-01", vo2From: "2025-09-01", workoutLimit: 2000, vo2Limit: 600, skipStreams: true });
  const source = sourceOf(data);
  const { early, target } = resolveRaces(source.races, opts.earlyDate, opts.targetDate);
  const link = (r: Race | null) => source.workouts.find(w => w.workoutId === r?.actualRunId);
  const ew = link(early), tw = link(target);
  const cfg: BacktestConfig = {
    earlyRaceId: early?.id ?? null, targetRaceId: target?.id ?? null,
    outcomes: { early: { official: opts.earlyOfficialSeconds ?? null, moving: ew ? ew.durationSeconds : null, elapsed: ew ? (ew.endDate.getTime() - ew.startDate.getTime()) / 1000 : null }, target: tw ? Math.round(tw.durationSeconds) : null },
    earlyRaceAvailableAt: ew?.syncedAt.toISOString() ?? null,
    owner: early && ew && opts.earlyOfficialSeconds ? {
      raceId: early.id, finishSeconds: opts.earlyOfficialSeconds, confirmedAt: opts.generatedAt, retrospectiveKnownAt: new Date(ew.syncedAt.getTime() + 60_000).toISOString(),
      conditions: ew.weather ? `${ew.weather.conditionText}, ${Math.round(ew.weather.tempF)}°F, wind ${Math.round(ew.weather.windMph)} mph, humidity ${Math.round(ew.weather.humidity)}% (recorded snapshot; the owner has not attested conditions)` : null,
      source: "owner attestation of the official finish time (no official-timing URL was supplied or checked)",
      timingReconciliation: "The attested official finish equals the watch moving duration. The watch elapsed time is longer because the recording began before the timed start (route recording paused for roughly the first ten minutes; heart rate near standing levels).",
    } : null,
    checkpoints: defaultCheckpoints({ preRaceInstant: localInstant(opts.targetDate, "05:00", TZ), earlyRaceDate: opts.earlyDate, targetRaceDate: opts.targetDate, earlyAvailableAt: ew?.syncedAt.toISOString() ?? null, extraDates: opts.dailyDates }),
  };
  const ids = streamCandidateIds(source, cfg);
  const streams = await loadStreamSummaries(ids, opts.streamCache);
  const report = buildBacktestReport({ source, streamSummaries: streams.summaries }, cfg, opts.generatedAt);
  const cost = { ...lastLiveReads, hrStreamChunks: streams.chunkReads, candidateRuns: ids.length, truncatedStreams: streams.truncated, failedStreams: streams.failed,
    note: "Document reads counted by the loaders (cached captures re-read nothing). Approximate list price $0.06 per 100,000 reads." };
  return { ...report, cost };
}
