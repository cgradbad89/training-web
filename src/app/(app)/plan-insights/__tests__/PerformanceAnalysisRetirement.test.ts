import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateHybridHalfMarathonV11 } from "@/utils/performance/hybridPerformanceV11";
import { estimateRaceDayForecast } from "@/utils/performance/raceDayForecast";
import { PERFORMANCE_ANALYSIS_HREF, PERFORMANCE_ANALYSIS_QUERY } from "@/lib/performanceAnalysisNavigation";

/** The manual Performance Analysis workflow is retired from navigation but fully preserved: nothing live may mount it,
 * and none of its stored-data code or saved-record contracts may disappear (the retirement is reversible). */
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : walk(path);
  return /\.(ts|tsx)$/.test(name) ? [path] : [];
});
const RETIRED_MODULES = [
  "src/components/PerformanceAnalysisPanel.tsx", "src/components/insights/PerformanceEvidenceStatus.tsx", "src/contexts/PerformanceEvidenceContext.tsx",
];
const PRESERVED_RECORDS = [
  "src/services/manualPerformance.ts", "src/services/performancePersistence.ts", "src/types/performanceAnalysis.ts", "src/types/performancePersistence.ts",
  "src/utils/sharedPerformanceEvidence.ts", "src/utils/performanceFreshness.ts", "src/utils/performanceSessionStore.ts",
];
const LIVE_EXCLUDED = new Set([...RETIRED_MODULES, ...PRESERVED_RECORDS]);

describe("Performance Analysis retirement", () => {
  it("no live source imports a retired surface or the manual-processing/persistence services", () => {
    const pattern = /(PerformanceAnalysisPanel|PerformanceEvidenceStatus|PerformanceEvidenceContext|services\/manualPerformance|services\/performancePersistence|usePerformanceEvidence)/;
    const offenders = walk("src").filter(file => !LIVE_EXCLUDED.has(file) && !file.startsWith("src/utils/research/") && pattern.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("preserves the retired components and every saved-record contract and service (nothing deleted)", () => {
    for (const file of [...RETIRED_MODULES, ...PRESERVED_RECORDS]) expect(existsSync(file), file).toBe(true);
    expect(readFileSync("src/services/manualPerformance.ts", "utf8")).toContain("runManualPerformanceUpdate");
    expect(readFileSync("src/services/performancePersistence.ts", "utf8")).toContain("getSavedPerformance");
  });
  it("keeps the old link constants so bookmarks resolve to a graceful notice instead of an error", () => {
    expect(PERFORMANCE_ANALYSIS_QUERY).toBe("performance-analysis");
    expect(PERFORMANCE_ANALYSIS_HREF).toBe("/plan-insights?performance-analysis=1");
  });
  it("keeps Hybrid v1.1 and Forecast v2 available", () => {
    expect(typeof estimateHybridHalfMarathonV11).toBe("function"); expect(typeof estimateRaceDayForecast).toBe("function");
  });
  it("the plan page no longer references the legacy button, dialog or evidence components", () => {
    const page = readFileSync("src/app/(app)/plan-insights/page.tsx", "utf8");
    expect(page).not.toMatch(/PerformanceEvidence|performance-analysis|evidenceNotice|evidenceDetails/);
    const actions = readFileSync("src/app/(app)/plan-insights/PlanPerformanceActions.tsx", "utf8");
    expect(actions).not.toMatch(/PerformanceAnalysisPanel|usePerformanceEvidence|view-performance-analysis/);
    expect(readFileSync("src/app/(app)/layout.tsx", "utf8")).not.toContain("PerformanceEvidenceProvider");
  });
});
