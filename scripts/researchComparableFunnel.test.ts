/** Live entry is SKIPPED unless FUNNEL is set. See scripts/researchComparableFunnel.ts. */
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { runLiveFunnel } from "./researchComparableFunnel";

it.skipIf(!process.env.FUNNEL)("LIVE (read-only): dated comparable-effort funnel", async () => {
  const report = await runLiveFunnel(process.env.FUNNEL_AS_OF ?? new Date().toISOString());
  const text = JSON.stringify(report, null, 2);
  if (process.env.FUNNEL_OUT) writeFileSync(process.env.FUNNEL_OUT, text);
  else console.log("[funnel]", text);
}, 300_000);
