/**
 * Env-gated Admin SDK runner. Skipped by the normal suite.
 *
 * Dry-run (default when enabled):
 *   REPAIR_BEST_EFFORTS=1 npx vitest run scripts/repairBestEffortsFreshness.run.test.ts
 * Apply:
 *   REPAIR_BEST_EFFORTS=commit npx vitest run scripts/repairBestEffortsFreshness.run.test.ts
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
    });
  },
  600_000
);
