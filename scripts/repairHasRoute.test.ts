/**
 * Env-gated runner for the hasRoute repair (see scripts/repairHasRoute.ts).
 * SKIPPED by default so `npm test` never touches Firestore. Enable explicitly:
 *
 *   Dry-run (no writes):   REPAIR=1       npx vitest run scripts/repairHasRoute.test.ts
 *   Apply (writes):        REPAIR=commit  npx vitest run scripts/repairHasRoute.test.ts
 *   With explicit uid:     REPAIR=1 REPAIR_UID=<uid> npx vitest run scripts/repairHasRoute.test.ts
 */
import { it } from "vitest";
import { runRepairHasRoute } from "./repairHasRoute";

const MODE = process.env.REPAIR; // undefined | "1"/"dry" | "commit"

it.skipIf(!MODE)(
  "repair hasRoute for run-like docs with a populated route subcollection",
  async () => {
    await runRepairHasRoute({
      commit: MODE === "commit",
      uid: process.env.REPAIR_UID,
    });
  },
  600_000
);
