/**
 * Env-gated Admin SDK runner. Skipped by the normal suite.
 *
 * Dry-run (default when enabled; reads NO routes, only the parent collection):
 *   REPAIR_BEST_EFFORTS=1 npx vitest run scripts/repairBestEffortsFreshness.run.test.ts
 *   (REPAIR_BEST_EFFORTS_VERIFY=1 additionally reads the selected routes, bounded by REPAIR_BEST_EFFORTS_LIMIT, to show value diffs)
 * Apply — REQUIRES a bound (LIMIT and/or SINCE); a full-history backfill is never implicit:
 *   REPAIR_BEST_EFFORTS=commit REPAIR_BEST_EFFORTS_LIMIT=10 REPAIR_BEST_EFFORTS_SINCE=2026-09-20 npx vitest run scripts/repairBestEffortsFreshness.run.test.ts
 * Optional uid:
 *   REPAIR_BEST_EFFORTS=1 REPAIR_BEST_EFFORTS_UID=<uid> npx vitest run scripts/repairBestEffortsFreshness.run.test.ts
 */

import { it } from "vitest";
import { repairBestEffortsFreshness } from "./repairBestEffortsFreshness";

const MODE = process.env.REPAIR_BEST_EFFORTS;

it.skipIf(!MODE)(
  "repairs best-effort freshness metadata and stale complete-route values",
  async () => {
    await repairBestEffortsFreshness({
      dryRun: MODE !== "commit",
      uid: process.env.REPAIR_BEST_EFFORTS_UID,
      limit: process.env.REPAIR_BEST_EFFORTS_LIMIT ? Number(process.env.REPAIR_BEST_EFFORTS_LIMIT) : undefined,
      since: process.env.REPAIR_BEST_EFFORTS_SINCE,
      verifyRoutes: process.env.REPAIR_BEST_EFFORTS_VERIFY === "1",
    });
  },
  600_000
);
