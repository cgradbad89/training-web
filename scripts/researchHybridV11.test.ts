/**
 * Live entry is SKIPPED unless HYBRID_RESEARCH is set. See scripts/researchHybridV11.ts.
 * The synthetic entry always runs: it proves the report builder is aggregate-only (no identifiers) on invented data.
 */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildV11Report, runHybridV11Research, type ProdReads } from "./researchHybridV11";
import type { HybridLoaded } from "./researchHybrid";
import { athleteV11 } from "@/utils/__tests__/fixtures/hybridV11Fixture";

it("synthetic: the v1.1 report builder is deterministic (modulo timings), aggregate-only and labels accuracy NOT EVALUABLE", () => {
  const a = athleteV11({ raceDate: "2026-07-30", strong: [{ date: "2026-10-02", miles: 6, pace: 548, hr: 172 }, { date: "2026-10-16", miles: 7, pace: 552, hr: 172 }, { date: "2026-10-28", miles: 6, pace: 546, hr: 172 }],
    segments: [{ date: "2026-10-20", hostMiles: 8, hostPace: 585, hr: 148, key: "10k", segPace: 545, type: "Tempo Run" }] });
  const data: HybridLoaded = { races: a.races, workouts: a.workouts, overrides: a.overrides, plans: [], vo2: [], streams: {}, truncated: false };
  const prod: ProdReads = { vo2: { entries: [], docsRead: 0, windowDays: 70 }, streams: { summaries: {}, candidates: 0, eligible: 0, withStream: 0, chunkReads: 0, truncated: 0, failed: 0, ms: 0 } };
  const report = buildV11Report(data, "2026-11-07T17:00:00.000Z", prod);
  const text = JSON.stringify(report);
  expect(text).not.toMatch(/ord-\d|strong-2026|seg-2026|hm-run|"workoutId"/);
  expect(report.accuracy.status).toBe("NOT EVALUABLE");
  expect(report.current.hybrid_v11.status).not.toBe("unavailable");
  expect(report.current.contribution.recentShare).toBeGreaterThan(0);
  expect(report.cost.extraFirestoreReadsV1).toBe(0); expect(report.cost.extraFirestoreReadsV11.total).toBe(0);
  expect(report.forecast.v2.version).toBe("experimental-raceday-forecast-v2"); expect(report.forecast.v1.version).toBe("experimental-raceday-forecast-v1");
  const strip = (r: unknown) => JSON.stringify(r, (k, v) => (k === "computeMs" || k === "readMs" ? undefined : v));
  expect(strip(buildV11Report(data, "2026-11-07T17:00:00.000Z", prod))).toBe(strip(report));
}, 120_000);

it.skipIf(!process.env.HYBRID_RESEARCH)("LIVE (read-only): hybrid v1.1 evaluation (aggregates only)", async () => {
  const report = await runHybridV11Research(process.env.HYBRID_RESEARCH_AS_OF ?? new Date().toISOString(), process.env.HYBRID_RESEARCH_CACHE, process.env.HYBRID_RESEARCH_SAVE_CACHE,
    process.env.HYBRID_V11_PROD_CACHE, process.env.HYBRID_V11_SAVE_PROD_CACHE);
  const text = JSON.stringify(report, null, 2);
  if (process.env.HYBRID_RESEARCH_OUT) writeFileSync(process.env.HYBRID_RESEARCH_OUT, text); else console.log("[hybrid-v11-research]", text);
}, 900_000);
