import type { Race } from "@/types/race";

/**
 * The owner-approved, estimator-level modelling assumption: a confirmed race whose attested effort is `hard` or `nonmaximal` is treated as a
 * MAXIMAL-effort performance anchor for PREDICTION purposes (official v2, HR-enhanced, hybrid v1, hybrid v1.1 and the race-day forecast).
 * The owner accepts the resulting inaccuracy in exchange for usable estimates; there is no effort percentage, coefficient or discount.
 *
 * This is deliberately the ONLY implementation: a pure adapter applied to the races handed to the estimators. It
 *   - rewrites the effort label in a COPY (legacy `performanceEvidence` and every `confirmationHistory` revision); stored records, timestamps,
 *     finish times, notes and history are never touched, and research / validation / evidence reporting keep the true classification because they
 *     never call this;
 *   - cannot make an invalid confirmation valid: race identity, timing reconciliation, historical availability (revision available as of the cutoff),
 *     conditions, the 180-day limit and every other integrity check still run unchanged inside the estimators;
 *   - leaves `maximal` and `unknown` untouched (an unknown effort is not attested as hard or nonmaximal).
 * Without it (rollback switch) hybrid v1.1 still handles such races through the labelled demonstrated-race policy.
 */
const ASSUMED = (effort: unknown) => effort === "hard" || effort === "nonmaximal";

export function treatConfirmedRacesAsMaximal(races: readonly Race[]): Race[] {
  return races.map(race => {
    let next = race;
    const legacy = race.performanceEvidence;
    if (legacy && ASSUMED(legacy.effort)) next = { ...next, performanceEvidence: { ...legacy, effort: "maximal" } };
    const history = race.confirmationHistory;
    const revisions = history && typeof history === "object" && history.revisions && typeof history.revisions === "object" ? history.revisions : null;
    if (history && revisions && Object.values(revisions).some(r => ASSUMED(r?.details?.effort))) {
      next = { ...next, confirmationHistory: { ...history, revisions: Object.fromEntries(Object.entries(revisions).map(([id, r]) =>
        [id, r && ASSUMED(r.details?.effort) ? { ...r, details: { ...r.details, effort: "maximal" as const } } : r])) } };
    }
    return next;
  });
}

/** How many races the assumption re-reads (for the single explanatory line in Estimate Details). */
export function assumedMaximalRaceCount(races: readonly Race[]): number {
  return treatConfirmedRacesAsMaximal(races).filter((race, i) => race !== races[i]).length;
}
