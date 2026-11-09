/**
 * Live entry is SKIPPED unless HYBRID_RESEARCH is set. See scripts/researchHybridTargets.ts.
 * The synthetic entry always runs: it proves the report builder is aggregate-only (no identifiers) on invented data.
 */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildTargetsReport, runTargetsResearch } from "./researchHybridTargets";
import type { HybridLoaded } from "./researchHybrid";
import type { ProdReads } from "./researchHybridV11";
import { SEPTEMBER_RACE, fitnessWorld } from "@/utils/__tests__/fixtures/currentFitnessFixture";

it("synthetic: the four-distance report is deterministic, aggregate-only, keeps half-marathon parity and labels accuracy NOT EVALUABLE", () => {
  const w = fitnessWorld({ asOfDate: "2026-11-20", races: [SEPTEMBER_RACE()], gaps: [1, 2, 2, 2], miles: [7, 8, 9, 16, 6, 8], adapted: false });
  const data: HybridLoaded = { races: w.races, workouts: w.workouts, overrides: w.overrides, plans: [], vo2: [], streams: {}, truncated: false };
  const prod: ProdReads = { vo2: { entries: [], docsRead: 0, windowDays: 70 }, streams: { summaries: {}, candidates: 0, eligible: 0, withStream: 0, chunkReads: 0, truncated: 0, failed: 0, ms: 0 } };
  const report = buildTargetsReport(data, "2026-11-20T17:00:00.000Z", prod);
  const text = JSON.stringify(report);
  expect(text).not.toMatch(/ord-\d|cad-\d|run-september|"workoutId"/);
  expect(report.currentFitness.rows.map(r => r.distance)).toEqual(["5K", "10 miles", "Half marathon", "Marathon"]);
  expect(report.halfMarathonParity.identical).toBe(true);
  expect(report.accuracy.perDistance.every(s => s.status === "NOT EVALUABLE")).toBe(true);
  expect(report.cost.extraFirestoreReads.total).toBe(0);
  expect(report.milesCheck.map(m => m.miles)).toEqual([3.1069, 10, 13.1094, 26.2188]);
  expect(JSON.stringify(buildTargetsReport(data, "2026-11-20T17:00:00.000Z", prod))).toBe(text);
}, 120_000);

it.skipIf(!process.env.HYBRID_RESEARCH)("LIVE (read-only): four-distance hybrid v1.1 evaluation (aggregates only)", async () => {
  const report = await runTargetsResearch(process.env.HYBRID_RESEARCH_AS_OF ?? new Date().toISOString(), process.env.HYBRID_RESEARCH_CACHE, process.env.HYBRID_RESEARCH_SAVE_CACHE,
    process.env.HYBRID_V11_PROD_CACHE, process.env.HYBRID_V11_SAVE_PROD_CACHE);
  const text = JSON.stringify(report, null, 2);
  if (process.env.HYBRID_RESEARCH_OUT) writeFileSync(process.env.HYBRID_RESEARCH_OUT, text); else console.log("[hybrid-targets-research]", text);
}, 900_000);
