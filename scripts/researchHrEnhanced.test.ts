/** Live entry is SKIPPED unless HR_RESEARCH is set. See scripts/researchHrEnhanced.ts. */
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { runHrResearch } from "./researchHrEnhanced";

it.skipIf(!process.env.HR_RESEARCH)("LIVE (read-only): HR-enhanced candidate research (aggregates only)", async () => {
  const report = await runHrResearch(process.env.HR_RESEARCH_AS_OF ?? new Date().toISOString(), process.env.HR_RESEARCH_CACHE);
  const text = JSON.stringify(report, null, 2);
  if (process.env.HR_RESEARCH_OUT) writeFileSync(process.env.HR_RESEARCH_OUT, text); else console.log("[hr-research]", text);
}, 600_000);
