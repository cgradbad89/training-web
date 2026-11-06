import type { Race } from "@/types/race";
import { toDate } from "./dates";
import { normalizeRaceConfirmationHistory } from "./raceConfirmation";

/** Preserve invalid history presence so an evaluator cannot fall back to legacy trust. */
export function normalizeRaceDocument(id: string, data: Record<string, unknown>): Race {
  return {
    ...data, id,
    raceDate: toDate(data.raceDate).toISOString().split("T")[0],
    createdAt: toDate(data.createdAt).toISOString(),
    ...(Object.prototype.hasOwnProperty.call(data, "confirmationHistory")
      ? { confirmationHistory: normalizeRaceConfirmationHistory(data.confirmationHistory) } : {}),
  } as Race;
}
