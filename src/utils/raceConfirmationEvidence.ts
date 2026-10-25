import type { Race } from "@/types/race";
import type { RaceConfirmationRevision } from "@/types/raceConfirmation";
import type { RacePerformanceConfirmation } from "@/types/racePerformance";
import { performanceLocalDate } from "@/utils/performanceEvidence";
import { normalizeRaceConfirmationHistory } from "@/utils/raceConfirmation";

export interface SelectedRaceConfirmation {
  present: boolean;
  revision: RaceConfirmationRevision | null;
  confirmation: RacePerformanceConfirmation | undefined;
  reasons: string[];
}

/** Validate the stored chain without promoting its client-writable timestamps to
 * trusted chronology. Never fall back to an older contract when history exists.
 * A future correction cannot replace the exact revision available at asOf. */
export function selectRaceConfirmationEvidence(race: Race, asOf: string, timeZone: string): SelectedRaceConfirmation {
  if (race.confirmationHistory === undefined) return { present: false, revision: null, confirmation: undefined, reasons: [] };
  const invalid = (): SelectedRaceConfirmation => ({ present: true, revision: null, confirmation: undefined, reasons: ["invalid_confirmation_history"] });
  const history = normalizeRaceConfirmationHistory(race.confirmationHistory);
  if (!history) return invalid();
  const ordered = Object.values(history.revisions).sort((a, b) => a.revisionNumber - b.revisionNumber);
  let previousTime = -Infinity;
  let unresolved = false;
  for (const revision of ordered) {
    if (revision.observations.race.id !== race.id) return invalid();
    if (revision.availableAt === null) { unresolved = true; continue; }
    const available = Date.parse(revision.availableAt);
    if (unresolved || available < previousTime || performanceLocalDate(revision.availableAt, timeZone) < revision.details.raceDate) return invalid();
    previousTime = available;
  }
  const revision = ordered.filter(item => item.availableAt !== null && Date.parse(item.availableAt) <= Date.parse(asOf)).at(-1) ?? null;
  if (!revision) return { present: true, revision: null, confirmation: undefined,
    reasons: [unresolved ? "unknown_confirmation_revision_time" : "confirmation_not_available_as_of"] };
  const details = revision.details;
  return { present: true, revision,
    confirmation: { status: details.status, kind: details.kind, knownAt: revision.availableAt!, raceDate: details.raceDate,
      distanceMeters: details.distanceMeters, finishSeconds: details.finishSeconds, effort: details.effort,
      conditions: details.conditions, source: details.source, timingReconciliation: details.timingReconciliation ?? undefined },
    reasons: [],
  };
}
