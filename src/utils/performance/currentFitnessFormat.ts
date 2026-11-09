/** Presentation helpers for the four-distance current-fitness table. Pure; no I/O. */
import type { ConfidenceRestriction } from "@/types/hybridPerformanceV11";
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

/** All applicable restrictions, including low-confidence available rows; empty when none apply. */
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
  const notes: string[] = [];
  if (row.flags.includes("inconsistent_with_adjacent_distance")) notes.push("Estimates are inconsistent with the neighbouring distance.");
  notes.push(...confidenceRestrictionMessages(row.estimate.confidenceRestrictions ?? []));
  return notes.join(" ");
}

const RESTRICTION_MESSAGES: Record<ConfidenceRestriction, string> = {
  limited_corroboration: "Too few independent observations support the estimate.",
  limited_precision: "Evidence is not precise enough for Moderate.",
  within_group_conflict: "Some performance evidence disagrees.",
  signal_conflict: "Independent signals disagree.",
  opposing_adjustments: "Physiology and endurance adjustments point in opposite directions.",
  readiness_unknown: "Endurance readiness is unknown.",
  readiness_low: "Endurance readiness is below the Moderate threshold.",
  race_age: "The estimate relies mainly on a race over 42 days old.",
  distant_evidence: "Much of the estimate is converted from a distant race distance.",
  marathon_durability: "Long-run and volume evidence is below marathon-ready levels.",
  vo2_disagreement: "VO₂ evidence disagrees with the physiological trend.",
  demonstrated_performance: "Based on demonstrated performance, not a maximal prediction.",
};

export function confidenceRestrictionMessages(restrictions: readonly ConfidenceRestriction[]): string[] {
  return restrictions.map(reason => RESTRICTION_MESSAGES[reason]);
}
