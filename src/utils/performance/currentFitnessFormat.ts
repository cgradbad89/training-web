/** Presentation helpers for the four-distance current-fitness table. Pure; no I/O. */
import type { CurrentFitnessRow } from "./hybridCurrentFitness";

/** "28:30" under an hour, "2:11:00" otherwise. Seconds are rounded to whole seconds; non-positive / non-finite → an em dash. */
export function formatFinishTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Pace per mile as "M:SS" (e.g. 600 → "10:00"). */
export function formatPacePerMile(secondsPerMile: number | null | undefined): string {
  if (secondsPerMile === null || secondsPerMile === undefined || !Number.isFinite(secondsPerMile) || secondsPerMile <= 0) return "—";
  const total = Math.round(secondsPerMile);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Local calendar date for a "YYYY-MM-DD" string, e.g. "Nov 10, 2026" (never shifted by the viewer's time zone). */
export function formatAsOfDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export type ConfidenceLabel = "Moderate" | "Low" | "Insufficient evidence";
export function confidenceLabel(row: Pick<CurrentFitnessRow, "status" | "confidence">): ConfidenceLabel {
  if (row.status === "unavailable") return "Insufficient evidence";
  return row.confidence === "moderate" ? "Moderate" : "Low";
}

/** One short, plain-language line for a provisional or unavailable row ("" when the row needs none). */
export function rowNote(row: CurrentFitnessRow): string {
  if (row.status === "unavailable") {
    switch (row.unavailableCause) {
      case "no_performance_evidence": return "No qualifying race or strong effort yet.";
      case "anchor_expired_no_contemporary_evidence": return "Latest race is over 180 days old.";
      case "insufficient_independent_evidence": return "Needs a recent race or two strong efforts.";
      case "insufficient_endurance_preparation":
        return row.id === "marathon" ? "Needs recent long runs (12+ miles) before a marathon time is estimated." : "Recent long runs and volume are too low.";
      default: return "Not enough evidence.";
    }
  }
  if (row.status !== "provisional") return "";
  const text = row.provisionalReasons.join(" ");
  if (/implausible distance-scaling/.test(text)) return "Provisional: inconsistent with the neighbouring distance.";
  if (/mostly converted from longer-distance evidence/.test(text)) return "Provisional: converted from longer-distance results.";
  if (/durability is not demonstrated/.test(text)) return "Provisional: long-run and volume evidence is below marathon-ready levels.";
  if (/aging race/.test(text)) return "Provisional: rests mainly on an aging race.";
  if (/not run at maximal effort|demonstrated performance/.test(text)) return "Provisional: demonstrated performance, not a maximal prediction.";
  if (row.id === "marathon" && /Evidence quality is limited/.test(text)) return "Provisional: estimated from shorter-distance results; no marathon-distance performance yet.";
  return "Provisional: limited or conflicting evidence.";
}
