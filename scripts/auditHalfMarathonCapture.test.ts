// @vitest-environment node
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { auditCaptures } from "../tools/race-validation/capture-audit";
import { createPrivateCaptureStore } from "../tools/race-validation/capture-storage";
import { readTarget } from "../tools/race-validation/evidence";
import { pilotTarget } from "../tools/race-validation/scheduled-capture";
import { canonicalizePerformanceValue } from "@/utils/performanceEvidence";

/**
 * Read-only post-race retrieval. Supply a short-lived verifier access token from the shell, for example
 * `PHASE3F_VERIFIER_TOKEN=$(gcloud auth print-access-token --impersonate-service-account=<verifier>)`.
 * Nothing here writes to Google Cloud or Firestore, and output files are created exclusively with mode 0600.
 *
 * Phase 3H: the default is the pinned March 20, 2027 race. For any other tracked race set PHASE3H_RACE_DATE
 * (YYYY-MM-DD, the date stored when it was tracked; PHASE3H_TIME_ZONE defaults to America/New_York). Optional
 * PHASE3H_ENROLLED_FROM / PHASE3H_CANCELED_AT (ISO instants) label slots as `not_enrolled` / `canceled`
 * instead of `missed`. Existing evidence is verified regardless.
 */
it.skipIf(!process.env.PHASE3F_AUDIT)("audits and retrieves verified half-marathon capture receipts", async () => {
  const { PHASE3F_BUCKET, PHASE3F_VERIFIER_TOKEN, PHASE3F_VERIFIER_PRINCIPAL, PHASE3F_SUBJECT, PHASE3F_RACE_ID, PHASE3F_OUTPUT_PREFIX } = process.env;
  if (!PHASE3F_BUCKET || !PHASE3F_VERIFIER_TOKEN || !PHASE3F_VERIFIER_PRINCIPAL || !PHASE3F_SUBJECT || !PHASE3F_RACE_ID || !PHASE3F_OUTPUT_PREFIX) {
    throw new TypeError("Set PHASE3F_BUCKET, PHASE3F_VERIFIER_TOKEN, PHASE3F_VERIFIER_PRINCIPAL, PHASE3F_SUBJECT, PHASE3F_RACE_ID and PHASE3F_OUTPUT_PREFIX");
  }
  const store = createPrivateCaptureStore({
    bucket: PHASE3F_BUCKET, minimumRetentionSeconds: 120 * 86_400, retentionMode: "unlocked_pilot", request: fetch,
    verifier: { principal: PHASE3F_VERIFIER_PRINCIPAL, accessToken: async () => PHASE3F_VERIFIER_TOKEN },
  });
  const { PHASE3H_RACE_DATE, PHASE3H_TIME_ZONE, PHASE3H_ENROLLED_FROM, PHASE3H_CANCELED_AT } = process.env;
  const target = PHASE3H_RACE_DATE
    ? readTarget({ subject: PHASE3F_SUBJECT, raceId: PHASE3F_RACE_ID, raceDate: PHASE3H_RACE_DATE, timeZone: PHASE3H_TIME_ZONE ?? "America/New_York" })
    : pilotTarget(PHASE3F_SUBJECT, PHASE3F_RACE_ID);
  const report = await auditCaptures(target, new Date().toISOString(), store, { enrolledFrom: PHASE3H_ENROLLED_FROM, canceledAt: PHASE3H_CANCELED_AT });
  const write = (suffix: string, value: unknown) => writeFileSync(`${PHASE3F_OUTPUT_PREFIX}.${suffix}.json`, canonicalizePerformanceValue(value) + "\n", { mode: 0o600, flag: "wx" });
  write("audit", report.rows);
  write("checkpoints", report.checkpoints);
  write("custody", report.custody);
  expect(report.healthy).toBe(true);
});
