/**
 * Live entry is SKIPPED unless BACKTEST is set. See scripts/researchAprilSeptemberBacktest.ts.
 * Synthetic tests for the toolkit live in src/utils/research/__tests__/historicalBacktest.test.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import { athleteV11 } from "@/utils/__tests__/fixtures/hybridV11Fixture";
import { researchRace } from "@/utils/__tests__/fixtures/workoutRaceResearchFixture";
import { buildBacktestReport, defaultCheckpoints, resolveRaces, streamCandidateIds, VARIANTS, type BacktestConfig } from "./researchAprilSeptemberBacktest";
import { localInstant, type BacktestSource } from "@/utils/research/historicalBacktest";
import { runBacktest } from "./researchAprilSeptemberBacktest";

function synthetic(): { source: BacktestSource; cfg: BacktestConfig } {
  const a = athleteV11({ raceDate: "2026-04-26", raceSeconds: 8130, start: "2026-01-05", trainingEnd: "2026-09-19", asOf: "2026-09-21T12:00:00Z",
    strong: [{ date: "2026-02-20", miles: 5, pace: 560, hr: 172 }, { date: "2026-03-14", miles: 6, pace: 556, hr: 172 }] });
  const early = a.races[0], run = a.workouts.find(w => w.workoutId === early.actualRunId)!;
  const fixed: HealthWorkout = { ...run, endDate: new Date(run.startDate.getTime() + 8759 * 1000) };
  fixed.syncedAt = new Date(fixed.endDate.getTime() + 1000);
  const target = researchRace("dc", "2026-09-20", 7871, false);
  const source: BacktestSource = { races: [early, target.race], workouts: [...a.workouts.filter(w => w !== run), fixed, target.workout], overrides: {}, plans: [], vo2: [], timeZone: "America/New_York" };
  const { early: e, target: t } = resolveRaces(source.races, "2026-04-26", "2026-09-20");
  const cfg: BacktestConfig = { earlyRaceId: e!.id, targetRaceId: t!.id, outcomes: { early: { moving: 8130, elapsed: 8759 }, target: 7871 },
    earlyRaceAvailableAt: fixed.syncedAt.toISOString(),
    checkpoints: defaultCheckpoints({ preRaceInstant: localInstant("2026-09-20", "05:00", "America/New_York"), earlyRaceDate: "2026-04-26", targetRaceDate: "2026-09-20", earlyAvailableAt: fixed.syncedAt.toISOString() }) };
  return { source, cfg };
}

it("synthetic: the backtest report is deterministic, aggregate-only, labelled by evidence kind, and never evaluable with two unqualified outcomes", () => {
  const { source, cfg } = synthetic();
  const report = buildBacktestReport({ source, streamSummaries: {} }, cfg, "2026-11-08T05:00:00.000Z");
  const text = JSON.stringify(report);
  expect(text).not.toMatch(/ord-\d|strong-2026|"hm-run"|"dc-run"|"workoutId"/);
  expect(report.labels).toMatch(/NOT predictions that existed|are NOT predictions/);
  expect(report.variants.map(v => v.id)).toEqual(VARIANTS.map(v => v.id));
  expect(report.calibration.evaluable).toBe(false); expect(report.calibration.qualified).toBe(0);
  expect(report.calibration.label).toBe("Historical case study — insufficient independent outcomes for scientific validation.");
  expect(report.outcomes.convention).toContain("predicted − actual");
  expect(JSON.stringify(buildBacktestReport({ source, streamSummaries: {} }, cfg, "2026-11-08T05:00:00.000Z"))).toBe(text);
}, 120_000);

it("synthetic: every checkpoint is a valid local instant strictly before the target race starts, and strict rows never use race clocks or physiology", () => {
  const { source, cfg } = synthetic();
  expect(cfg.checkpoints.every(c => Number.isFinite(Date.parse(c.asOf)))).toBe(true);
  expect(cfg.checkpoints.at(-1)!.asOf).toBe("2026-09-20T09:00:00.000Z");
  expect(cfg.checkpoints.some(c => c.label === "September 19" && c.required)).toBe(true);
  const report = buildBacktestReport({ source, streamSummaries: {} }, cfg, "2026-11-08T05:00:00.000Z");
  for (const t of report.timeline) {
    expect(t.asOf < "2026-09-20T11:00:00.000Z").toBe(true);
    expect(t.variants.strict_historical.provenance.counterfactual).toBeNull();
    expect(t.variants.strict_historical.provenance.hrStreamsWithheld).toBe(true);
    expect(t.variants.strict_historical.official.seconds).toBeNull();
  }
  const final = report.timeline.at(-1)!;
  expect(final.variants.counterfactual_early_moving_time.official.seconds).not.toBeNull();
  expect(report.targetRaceHoldout.reconstruction_as_recorded.predictedAndError.official_v2).toBeNull();     // unavailable is null, never zero
  const err = report.targetRaceHoldout.counterfactual_early_moving_time.predictedAndError.official_v2;
  expect(err).toBe(Math.round((final.variants.counterfactual_early_moving_time.official.seconds! - 7871) * 10) / 10);
}, 120_000);

it("synthetic: HR streams are requested only for runs production hydration would pick (bounded per checkpoint)", () => {
  const { source, cfg } = synthetic();
  const ids = streamCandidateIds(source, cfg);
  expect(ids.length).toBeLessThanOrEqual(16 * cfg.checkpoints.length * VARIANTS.length);
  expect(new Set(ids).size).toBe(ids.length);
});

it.skipIf(!process.env.BACKTEST)("LIVE (read-only): April → September 2026 historical case study", async () => {
  const report = await runBacktest({ cachePath: process.env.BACKTEST_CACHE, saveCache: process.env.BACKTEST_SAVE_CACHE, streamCache: process.env.BACKTEST_STREAM_CACHE,
    earlyDate: process.env.BACKTEST_EARLY_DATE ?? "2026-04-26", targetDate: process.env.BACKTEST_TARGET_DATE ?? "2026-09-20", generatedAt: process.env.BACKTEST_NOW ?? new Date().toISOString() });
  const text = JSON.stringify(report, null, 1);
  if (process.env.BACKTEST_OUT) { mkdirSync(dirname(process.env.BACKTEST_OUT), { recursive: true }); writeFileSync(process.env.BACKTEST_OUT, text); } else console.log("[backtest]", text);
}, 900_000);
