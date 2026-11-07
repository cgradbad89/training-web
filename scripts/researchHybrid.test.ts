/**
 * Live entry is SKIPPED unless HYBRID_RESEARCH is set. See scripts/researchHybrid.ts.
 * The synthetic entry always runs: it proves the report builder is aggregate-only (no identifiers) on invented data.
 */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildHybridResearchReport, runHybridResearch, type HybridLoaded } from "./researchHybrid";
import { hybridAthlete } from "@/utils/__tests__/fixtures/hybridFixture";

it("synthetic: the report builder is deterministic, aggregate-only and labels accuracy NOT EVALUABLE", () => {
  const a = hybridAthlete({ longRunMiles: 8, strong: [{ date: "2026-10-10", miles: 6, pace: 560, hr: 172 }, { date: "2026-10-24", miles: 6.5, pace: 555, hr: 172 }] });
  const data: HybridLoaded = { races: a.races, workouts: a.workouts, overrides: a.overrides, plans: [], vo2: [], streams: {}, truncated: false };
  const report = buildHybridResearchReport(data, "2026-11-07T17:00:00.000Z");
  const text = JSON.stringify(report);
  expect(text).not.toMatch(/ord-\d|strong-2026|hm-run|"workoutId"/); // no identifiers
  expect(report.accuracy.status).toBe("NOT EVALUABLE");
  expect(report.current.hybrid.status).not.toBe("unavailable");
  expect(report.forecast.status).toBe("provisional"); expect(report.forecast.plan).toBeNull(); // no plan supplied: conservative, plan-free projection
  expect(JSON.stringify(buildHybridResearchReport(data, "2026-11-07T17:00:00.000Z"))).toBe(text);
}, 60_000); // offline research report: daily replay and leave-one-out are intentionally heavy

it.skipIf(!process.env.HYBRID_RESEARCH)("LIVE (read-only): hybrid performance model evaluation (aggregates only)", async () => {
  const report = await runHybridResearch(process.env.HYBRID_RESEARCH_AS_OF ?? new Date().toISOString(), process.env.HYBRID_RESEARCH_CACHE, process.env.HYBRID_RESEARCH_SAVE_CACHE);
  const text = JSON.stringify(report, null, 2);
  if (process.env.HYBRID_RESEARCH_OUT) writeFileSync(process.env.HYBRID_RESEARCH_OUT, text); else console.log("[hybrid-research]", text);
}, 600_000);
