/**
 * Pure shoe-replacement projection.
 *
 * Given a shoe's current tracked miles + retirement limit and the dated runs
 * assigned to it, estimate how many miles remain and — from the RECENT rate
 * (last 4 weeks of that shoe's miles) — a projected replacement date.
 *
 * Read-only / in-memory: no Firestore, no storage, no input mutation.
 */

export interface ShoeProjectionInput {
  /** Current total tracked miles (startMileageOffset + assigned run miles). */
  currentMiles: number;
  /** Retirement mileage limit (RunningShoe.retirementMileageTarget). */
  limit: number | null | undefined;
}

/** One assigned run reduced to the only fields the projection needs. */
export interface ShoeRunMiles {
  dateISO: string;
  miles: number;
}

export type ShoeProjectionState = "ok" | "approaching" | "over" | "inactive";

export interface ShoeProjection {
  /** max(limit - currentMiles, 0). */
  milesRemaining: number;
  /** Avg over the last 4 weeks of THIS shoe's runs (sum of 28d miles ÷ 4). */
  recentMilesPerWeek: number;
  /** now + (milesRemaining / recentMilesPerWeek) weeks; null when over/inactive. */
  projectedDate: Date | null;
  state: ShoeProjectionState;
}

const WINDOW_DAYS = 28;
const WINDOW_WEEKS = 4;
const DAY_MS = 86_400_000;
const APPROACHING_FRACTION = 0.75;

/**
 * @returns a {@link ShoeProjection}, or `null` when no usable limit is set
 *          (no retirement target → nothing to project against; the card simply
 *          omits the line, matching the "No limit" mileage bar).
 *
 * State rules:
 *  - `currentMiles >= limit`        → "over",       projectedDate null
 *  - `recentMilesPerWeek <= 0`      → "inactive",   projectedDate null (no
 *                                     divide-by-zero; never a bogus "never")
 *  - else `currentMiles/limit >= 0.75` → "approaching" else "ok",
 *                                     projectedDate = now + weeksLeft·7 days
 */
export function projectShoeReplacement(
  shoe: ShoeProjectionInput,
  shoeRuns: ShoeRunMiles[],
  now: Date = new Date(),
): ShoeProjection | null {
  const limit = shoe.limit;
  if (limit == null || !isFinite(limit) || limit <= 0) return null;

  const currentMiles =
    isFinite(shoe.currentMiles) && shoe.currentMiles > 0 ? shoe.currentMiles : 0;
  const milesRemaining = Math.max(limit - currentMiles, 0);

  // Recent rate: miles within the last 28 days (inclusive of the 28-days-ago
  // boundary, exclusive of the future) ÷ 4 weeks.
  const nowMs = now.getTime();
  const windowStartMs = nowMs - WINDOW_DAYS * DAY_MS;
  let recentMiles = 0;
  for (const r of shoeRuns) {
    const t = new Date(r.dateISO).getTime();
    if (!isFinite(t)) continue;
    if (t >= windowStartMs && t <= nowMs && isFinite(r.miles) && r.miles > 0) {
      recentMiles += r.miles;
    }
  }
  const recentMilesPerWeek = recentMiles / WINDOW_WEEKS;

  // Already at/over the limit.
  if (currentMiles >= limit) {
    return { milesRemaining, recentMilesPerWeek, projectedDate: null, state: "over" };
  }

  // No recent miles → cannot honestly project a date.
  if (recentMilesPerWeek <= 0) {
    return { milesRemaining, recentMilesPerWeek, projectedDate: null, state: "inactive" };
  }

  const weeksLeft = milesRemaining / recentMilesPerWeek;
  const projectedDate = new Date(nowMs + weeksLeft * 7 * DAY_MS);
  const state: ShoeProjectionState =
    currentMiles / limit >= APPROACHING_FRACTION ? "approaching" : "ok";

  return { milesRemaining, recentMilesPerWeek, projectedDate, state };
}
