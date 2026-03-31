/**
 * Pace and speed utilities.
 * All distances in miles, all times in seconds unless noted.
 */

/** Format seconds-per-mile as "M:SS" */
export function formatPace(secPerMile: number): string {
  if (!secPerMile || secPerMile <= 0) return "--:--";
  const m = Math.floor(secPerMile / 60);
  const s = Math.round(secPerMile % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Format total seconds as "H:MM:SS" or "M:SS" */
export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Convert m/s to seconds-per-mile */
export function mpsToSecPerMile(mps: number): number {
  if (!mps || mps <= 0) return 0;
  const metersPerMile = 1609.344;
  return metersPerMile / mps;
}

/** Convert meters to miles */
export function metersToMiles(m: number): number {
  return m / 1609.344;
}

/** Format miles with 2 decimal places */
export function formatMiles(miles: number): string {
  return miles.toFixed(2);
}

/** Target finish time in seconds for a half marathon given pace in sec/mi */
export function halfMarathonFinishTime(paceSecPerMile: number): number {
  return paceSecPerMile * 13.109;
}

/**
 * Parse a pace string in "M:SS" or "MM:SS" format into seconds per mile.
 * Returns null if the string is invalid.
 */
export function parsePaceString(pace: string): number | null {
  const trimmed = pace.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  if (seconds >= 60) return null;
  const total = minutes * 60 + seconds;
  return total > 0 ? total : null;
}
