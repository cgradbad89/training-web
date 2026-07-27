/**
 * Env-gated runner for the weeks 13-18 plan content work (see
 * scripts/updatePlanWeeks13to18.ts). SKIPPED by default so `npm test` never
 * touches Firestore.
 *
 * Field updates (session 1):
 *   Dry-run:   UPDATEPLAN=update-dry    npx vitest run scripts/updatePlanWeeks13to18.test.ts
 *   Commit:    UPDATEPLAN=update-commit npx vitest run scripts/updatePlanWeeks13to18.test.ts
 *
 * Missing-entry inserts (session 2):
 *   Dry-run:   UPDATEPLAN=insert-dry    npx vitest run scripts/updatePlanWeeks13to18.test.ts
 *   Commit:    UPDATEPLAN=insert-commit npx vitest run scripts/updatePlanWeeks13to18.test.ts
 *
 * Inspection (read-only):
 *   UPDATEPLAN=inspect      — raw entries in a date range
 *   UPDATEPLAN=inspect-full — full JSON of entries for weeks 14-18
 */
import { it } from "vitest";
import {
  runUpdatePlanWeeks,
  runInsertMissingEntries,
  dumpRawRange,
  dumpFullEntriesForWeeks,
} from "./updatePlanWeeks13to18";

const MODE = process.env.UPDATEPLAN;

it.skipIf(MODE !== "inspect")(
  "dump raw stored entries in range",
  async () => {
    await dumpRawRange("2026-08-01", "2026-09-25");
  },
  120_000
);

it.skipIf(MODE !== "inspect-full")(
  "dump full JSON of entries for weeks 14-18",
  async () => {
    await dumpFullEntriesForWeeks([14, 15, 16, 17, 18]);
  },
  120_000
);

it.skipIf(MODE !== "update-dry" && MODE !== "update-commit")(
  "update weeks 13-18 of the active running plan",
  async () => {
    await runUpdatePlanWeeks({ commit: MODE === "update-commit" });
  },
  120_000
);

it.skipIf(MODE !== "insert-dry" && MODE !== "insert-commit")(
  "insert the 7 missing entries stripped by reduced-travel-v1",
  async () => {
    await runInsertMissingEntries({ commit: MODE === "insert-commit" });
  },
  120_000
);
