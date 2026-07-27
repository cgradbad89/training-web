/**
 * Env-gated runner for the weeks 13-18 plan content update (see
 * scripts/updatePlanWeeks13to18.ts). SKIPPED by default so `npm test` never
 * touches Firestore.
 *
 *   Dry-run (no writes):   UPDATEPLAN=1      npx vitest run scripts/updatePlanWeeks13to18.test.ts
 *   Commit (writes):       UPDATEPLAN=commit npx vitest run scripts/updatePlanWeeks13to18.test.ts
 */
import { it } from "vitest";
import { runUpdatePlanWeeks, dumpRawRange } from "./updatePlanWeeks13to18";

const MODE = process.env.UPDATEPLAN;

it.skipIf(MODE !== "inspect")(
  "dump raw stored entries in range",
  async () => {
    await dumpRawRange("2026-08-01", "2026-09-25");
  },
  120_000
);

it.skipIf(!MODE || MODE === "inspect")(
  "update weeks 13-18 of the active running plan",
  async () => {
    await runUpdatePlanWeeks({ commit: MODE === "commit" });
  },
  120_000
);
