import type { Race } from "@/types/race";
import type { RaceConfirmationDraft } from "@/types/raceConfirmation";

/**
 * Starting values for the owner's two 2026 half marathons, supplied by the owner and shown in the EXISTING confirmation editor for review.
 * Nothing here is saved, attested or submitted automatically; no weather, course, URL or other fact is invented. Subjective effort
 * percentages appear only in the free-text conditions and are never read by any model. Matching is by race date and distance and applies
 * only to a race with no confirmation yet. Remove this file with the temporary production gate once both confirmations are saved.
 */
export interface OwnerConfirmationPrefill {
  finish: string;
  timeBasis: RaceConfirmationDraft["timeBasis"];
  status: RaceConfirmationDraft["status"];
  effort: RaceConfirmationDraft["effort"];
  conditions: string;
  source: string;
  timingReconciliation: string;
}

const PREFILL: Record<string, OwnerConfirmationPrefill> = {
  // PNC Alexandria Half Marathon: official 2:15:30 (owner-attested), chip-versus-gun basis not established.
  "2026-04-26": {
    finish: "2:15:30", timeBasis: "other", status: "owner_confirmed", effort: "nonmaximal",
    conditions: "Owner-described effort approximately 80% (subjective, not a physiological measurement).",
    source: "Owner attestation of the official finish time 2:15:30, entered by the owner in a signed-in session. No official results page was checked by the app, and the chip-versus-gun basis was not established.",
    timingReconciliation: "The watch recording began approximately 10 minutes 29 seconds before the timed race start; the early portion contains no route movement and standing-level heart rate. The watch moving duration (2:15:30) equals the official finish.",
  },
  // DC Half Marathon: official chip finish 2:11:11, confirmed by the owner; recorded duration agrees.
  "2026-09-20": {
    finish: "2:11:11", timeBasis: "chip", status: "owner_confirmed", effort: "hard",
    conditions: "Owner-described effort approximately 90% (subjective, not a physiological measurement).",
    source: "Owner confirmation of the official chip finish time 2:11:11, entered by the owner in a signed-in session.",
    timingReconciliation: "",
  },
};

export function ownerRaceConfirmationPrefill(race: Race): OwnerConfirmationPrefill | null {
  if (race.raceDistance !== "halfMarathon" || race.confirmationHistory) return null;
  return PREFILL[race.raceDate] ?? null;
}
