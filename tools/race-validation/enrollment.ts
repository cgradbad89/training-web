import { createHash } from "node:crypto";
import { performanceLocalDate, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { HALF_MARATHON_MILES } from "@/types/race";
import { checkpointKey, readTarget, targetKey, type Horizon, type Target } from "./evidence";

/**
 * Reusable enrollment (Phase 3H). Pure and stateless: given the pinned enrollment and a bounded read of the
 * owner's saved active races, decide which races are tracked today. It never reads Firestore, never writes,
 * and never changes the estimator. The saved `isActive` flag is the only source of truth; a Plan Insights
 * picker selection is client state and is never an input.
 */

export const DEFAULT_ENROLLMENT_TIME_ZONE = "America/New_York";
/** Active races fetched per discovery. More than one eligible candidate is already a conflict. */
export const ACTIVE_RACE_QUERY_LIMIT = 5;
/** Custom distances within this many miles of 13.109 count as a half marathon. */
const CUSTOM_DISTANCE_TOLERANCE_MILES = 0.1;

/** Minimal race metadata. No name, result, evidence, plan, location or workout data. */
export interface RaceMeta {
  id: string;
  /** Normalized `YYYY-MM-DD`, or null when the stored value was malformed. */
  raceDate: string | null;
  raceDistance?: unknown;
  customDistanceMiles?: unknown;
  isActive?: unknown;
}

export type Ineligible = "not_active" | "not_half_marathon" | "invalid_date" | "invalid_identity" | "past_final_checkpoint";

export type EnrollmentNote = "auto_disabled" | "discovery_failed" | "discovery_overflow" | "conflict" | "none_eligible";

export interface EnrollmentPlan {
  /** Pinned enrollment first, then at most one automatically discovered race. Never contains duplicates. */
  targets: Target[];
  notes: EnrollmentNote[];
  counts: { candidates: number; eligible: number; ineligible: Partial<Record<Ineligible, number>> };
}

export function isHalfMarathon(meta: Pick<RaceMeta, "raceDistance" | "customDistanceMiles">): boolean {
  if (meta.raceDistance === "halfMarathon") return true;
  const miles = meta.customDistanceMiles;
  return meta.raceDistance === "custom" && typeof miles === "number" && Number.isFinite(miles)
    && Math.abs(miles - HALF_MARATHON_MILES) <= CUSTOM_DISTANCE_TOLERANCE_MILES;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Why a saved race may not be tracked on `today` (owner-local date), or null when it may. */
export function raceIneligibility(meta: RaceMeta, today: string): Ineligible | null {
  if (typeof meta.id !== "string" || meta.id.length === 0 || meta.id.includes("/")) return "invalid_identity";
  if (meta.isActive !== true) return "not_active";
  if (!isHalfMarathon(meta)) return "not_half_marathon";
  if (!validDate(meta.raceDate)) return "invalid_date";
  // The 1-day checkpoint is the last one. Once its local day has passed nothing can ever be due.
  if (shiftPerformanceDate(meta.raceDate, -1) < today) return "past_final_checkpoint";
  return null;
}

/**
 * Decide today's tracked races.
 *
 * - `pinned` (the March 2027 commitment) is always kept. No discovery outcome, edit, deactivation or
 *   deletion of any race can remove it.
 * - `discovered === null` means the metadata read failed or overflowed: keep the pinned target only.
 * - Two or more eligible non-pinned active races are a conflict: enroll none of them, surface the note.
 * - A race that is already the pinned race is never enrolled a second time (same race id, any date).
 * - Nothing is backdated: a newly tracked race only yields checkpoints on or after the day it is first seen,
 *   because `dueCheckpoints` fires only for today's local date.
 */
export function resolveEnrollments(input: {
  pinned: Target | null;
  subject: string;
  timeZone: string;
  now: string;
  autoEnabled: boolean;
  discovered: readonly RaceMeta[] | null;
  overflow?: boolean;
}): EnrollmentPlan {
  const targets: Target[] = input.pinned ? [readTarget(input.pinned)] : [];
  const notes: EnrollmentNote[] = [];
  const counts: EnrollmentPlan["counts"] = { candidates: 0, eligible: 0, ineligible: {} };
  if (!input.autoEnabled) return { targets, notes: ["auto_disabled"], counts };
  if (input.discovered === null) return { targets, notes: ["discovery_failed"], counts };
  if (input.overflow) return { targets, notes: ["discovery_overflow"], counts };

  const today = performanceLocalDate(input.now, input.timeZone);
  const eligible: Target[] = [];
  for (const meta of input.discovered) {
    counts.candidates++;
    if (input.pinned && meta.id === input.pinned.raceId) continue; // pinned already covers this race id
    const reason = raceIneligibility(meta, today);
    if (reason) { counts.ineligible[reason] = (counts.ineligible[reason] ?? 0) + 1; continue; }
    try {
      eligible.push(readTarget({ subject: input.subject, raceId: meta.id, raceDate: meta.raceDate, timeZone: input.timeZone }));
    } catch {
      counts.ineligible.invalid_identity = (counts.ineligible.invalid_identity ?? 0) + 1;
    }
  }
  counts.eligible = eligible.length;
  if (eligible.length === 0) notes.push("none_eligible");
  else if (eligible.length > 1) notes.push("conflict");
  else targets.push(eligible[0]);
  return { targets, notes, counts };
}

/** Opaque, non-reversible reference for logs and responses. Reveals neither the race id nor the owner. */
export function enrollmentReference(target: Target): string {
  return createHash("sha256").update(targetKey(target)).digest("hex").slice(0, 12);
}

/** The four checkpoint dates derived from the stored race date, for display and audit. */
export function checkpointDates(target: Target, horizons: readonly Horizon[]) {
  return horizons.map(horizon => ({ horizon, checkpointDate: shiftPerformanceDate(target.raceDate, -horizon), key: checkpointKey(target, horizon) }));
}
