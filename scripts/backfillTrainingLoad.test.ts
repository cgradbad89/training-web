/**
 * Env-gated runner for the Training Load V2 backfill (see
 * scripts/backfillTrainingLoad.ts). SKIPPED by default so `npm test` never
 * touches Firestore. Enable explicitly:
 *
 *   Dry-run (no writes):   BACKFILL=1       npx vitest run scripts/backfillTrainingLoad.test.ts
 *   Commit (writes):       BACKFILL=commit  npx vitest run scripts/backfillTrainingLoad.test.ts
 *   With explicit uid:     BACKFILL=1 BACKFILL_UID=<uid> npx vitest run scripts/backfillTrainingLoad.test.ts
 *
 * Read-only staleness REPORT to a file (vitest buffers console):
 *   BACKFILL=1 BACKFILL_REPORT=/tmp/backfill_report.txt npx vitest run scripts/backfillTrainingLoad.test.ts
 * Targeted two-pass-collapse repair (writes ONLY STALE-flagged docs):
 *   BACKFILL=commit BACKFILL_STALE_ONLY=1 npx vitest run scripts/backfillTrainingLoad.test.ts
 * Targeted MISSING_LOAD repair (writes ONLY docs with a null/0 stored load):
 *   BACKFILL=commit BACKFILL_MISSING_ONLY=1 npx vitest run scripts/backfillTrainingLoad.test.ts
 */
import { it } from "vitest";
import { runBackfillTrainingLoad } from "./backfillTrainingLoad";

const MODE = process.env.BACKFILL; // undefined | "1"/"dry" | "commit"

it.skipIf(!MODE)(
  "backfill trainingLoadV2 over the last 12 months",
  async () => {
    await runBackfillTrainingLoad({
      commit: MODE === "commit",
      staleOnly: process.env.BACKFILL_STALE_ONLY === "1",
      missingOnly: process.env.BACKFILL_MISSING_ONLY === "1",
      uid: process.env.BACKFILL_UID,
    });
  },
  600_000
);
