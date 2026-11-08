import { describe, expect, it } from "vitest";
import { type RoutePoint } from "@/services/routes";
import {
  assessBestEffortsCache,
  BEST_EFFORTS_VERIFICATION,
  bestEffortsSuspicion,
  computeBestEfforts,
  nextVerificationAttempts,
  parseStoredBestEfforts,
  routeDistanceMeters,
  shouldRecomputeBestEfforts,
  shouldReplaceBestEfforts,
  withBestEffortsFreshness,
  type BestEffortsMap,
} from "@/utils/bestEfforts";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";

const EARTH_RADIUS_M = 3958.8 * 1609.344;
const START_MS = Date.UTC(2026, 10, 7, 14, 0, 0);
const MILE = 1609.344;
const point = (index: number, meters: number, seconds: number, timestamp?: string): RoutePoint => ({
  index, lat: (meters / EARTH_RADIUS_M) * (180 / Math.PI), lng: 0, altitude: 0,
  timestamp: timestamp ?? new Date(START_MS + seconds * 1000).toISOString(), speed: null, hr: null });
/** A steady run sampled once per second at `pace` s/mi for `meters`. */
function steadyRoute(meters: number, pace = 590): RoutePoint[] {
  const speed = MILE / pace, seconds = Math.floor(meters / speed);
  return Array.from({ length: seconds + 1 }, (_, i) => point(i, i * speed, i));
}
/** The workout facts a 9.18-mile, 90-minute run reports. */
const NINE_MILES = { distanceMiles: 9.18, durationSeconds: 5413 };
const record = (points: RoutePoint[], complete = true, extra = {}) =>
  withBestEffortsFreshness(computeBestEfforts(points), complete, points.length, { routeDistanceMeters: routeDistanceMeters(points), ...extra });

describe("assessBestEffortsCache: the six cache states", () => {
  const full = steadyRoute(9.18 * MILE);
  it("missing record on an eligible route → recoverable", () => {
    expect(assessBestEffortsCache(undefined, true, NINE_MILES)).toMatchObject({ state: "missing_recoverable", recompute: true });
  });
  it("valid current record from a full route → no recompute (idempotent repeat visits)", () => {
    const ok = record(full);
    expect(assessBestEffortsCache(ok, true, NINE_MILES)).toMatchObject({ state: "valid_current", recompute: false });
    expect(shouldRecomputeBestEfforts(ok, true, NINE_MILES)).toBe(false);
  });
  it("outdated computation version → stale and recoverable", () => {
    expect(assessBestEffortsCache({ ...record(full), computationVersion: BEST_EFFORTS_COMPUTATION_VERSION - 1 }, true, NINE_MILES)).toMatchObject({ state: "stale_version", recompute: true });
  });
  it("computed from a partial route that has since completed → recompute; while still partial → wait (no recompute)", () => {
    const partial = record(full.slice(0, 1200), false);
    expect(assessBestEffortsCache(partial, true, NINE_MILES)).toMatchObject({ state: "incomplete_route_completed", recompute: true });
    expect(assessBestEffortsCache(partial, false, NINE_MILES)).toMatchObject({ state: "temporarily_incomplete", recompute: false });
  });
  it("freshness metadata that is missing or unusable → recompute", () => {
    const base = record(full);
    expect(assessBestEffortsCache({ ...base, computedFromRouteComplete: undefined }, true, NINE_MILES).state).toBe("inconsistent_metadata");
    expect(assessBestEffortsCache({ ...base, computedFromPointCount: undefined }, true, NINE_MILES).state).toBe("inconsistent_metadata");
    expect(assessBestEffortsCache({ ...base, computedFromPointCount: Number.NaN }, true, NINE_MILES).state).toBe("inconsistent_metadata");
    expect(assessBestEffortsCache({ ...base, computedFromPointCount: -3 }, true, NINE_MILES).state).toBe("inconsistent_metadata");
  });
});

describe("the observed failure: a v2, 'complete' record computed from a truncated (mid-upload) route", () => {
  const truncated = record(steadyRoute(9.18 * MILE).slice(0, 400));            // 400 points of 5,400, flagged complete
  it("is all-null and was previously never recomputed", () => {
    expect(truncated.computedFromPointCount).toBe(400);
    expect(Object.values({ a: truncated["1mi"], b: truncated["5k"], c: truncated["10k"] }).every(v => v === null)).toBe(true);
    // the OLD rule (no workout facts) leaves it alone: complete flag, current version
    expect(shouldRecomputeBestEfforts(truncated, true)).toBe(false);
  });
  it("is now recognised from the workout's own duration and distance and recomputed", () => {
    const a = assessBestEffortsCache(truncated, true, NINE_MILES);
    expect(a).toMatchObject({ state: "suspicious_recoverable", recompute: true });
    expect(a.reasons).toEqual(expect.arrayContaining(["point_count_far_below_workout_duration", expect.stringContaining("null_for_distance_shorter_than_workout")]));
  });
  it("recovers: the recomputed record from the full route has values and is valid_current with no retry counter", () => {
    const full = steadyRoute(9.18 * MILE);
    const base = record(full);
    expect(nextVerificationAttempts(truncated, base, NINE_MILES)).toBe(0);
    const repaired = record(full, true, { verificationAttempts: nextVerificationAttempts(truncated, base, NINE_MILES) });
    expect(repaired["1mi"]).not.toBeNull(); expect(repaired["5k"]).not.toBeNull(); expect(repaired["10k"]).not.toBeNull();
    expect(repaired.verificationAttempts).toBeUndefined();
    expect(assessBestEffortsCache(repaired, true, NINE_MILES).state).toBe("valid_current");
  });
  it("a truncated record whose values are non-null but computed from far too few points is still suspicious (values would understate the run)", () => {
    const partialButValued = record(steadyRoute(9.18 * MILE).slice(0, 2600));
    expect(partialButValued["1mi"]).not.toBeNull();
    expect(bestEffortsSuspicion(partialButValued, NINE_MILES)).toContain("point_count_far_below_workout_duration");
    // and with a plausible point count and the nulls that follow only from a SHORT workout, nothing is suspicious
    expect(bestEffortsSuspicion(record(steadyRoute(4.5 * MILE)), { distanceMiles: 4.5, durationSeconds: 2655 })).toEqual([]);
  });
});

describe("a legitimately unavailable (all-null) record is not recomputed forever", () => {
  it("a short run that is simply shorter than every distance is valid_current, not suspicious", () => {
    const shortRoute = steadyRoute(0.6 * MILE);
    const rec = record(shortRoute);
    expect(Object.values([rec["1mi"], rec["5k"]]).every(v => v === null)).toBe(true);
    expect(assessBestEffortsCache(rec, true, { distanceMiles: 0.6, durationSeconds: shortRoute.length })).toMatchObject({ state: "valid_current", recompute: false });
  });
  it("a gapped route that cannot cover a distance the workout reports is retried a bounded number of times, then accepted", () => {
    const facts = { distanceMiles: 6.5, durationSeconds: 3900 };
    // GPS covers only 2.5 mi of a 6.5 mi workout (large gap); 1 point per second where present
    const gapped = steadyRoute(2.5 * MILE);
    let existing: BestEffortsMap | undefined = record(gapped);
    expect(assessBestEffortsCache(existing, true, facts).recompute).toBe(true);
    let attempts = 0;
    for (let pass = 1; pass <= 10 && assessBestEffortsCache(existing, true, facts).recompute; pass++) {
      const base = record(gapped);
      const next = nextVerificationAttempts(existing, base, facts);
      existing = record(gapped, true, { verificationAttempts: next });
      attempts = pass;
    }
    expect(attempts).toBe(BEST_EFFORTS_VERIFICATION.maxAttempts);
    expect(assessBestEffortsCache(existing, true, facts)).toMatchObject({ state: "unavailable_confirmed", recompute: false });
    expect(existing!.computedFromRouteDistanceMeters).toBeCloseTo(2.5 * MILE, 0);        // the stored distance explains the nulls
  });
  it("unreliable timestamps (non-increasing / invalid) produce nulls that are bounded the same way", () => {
    const bad = steadyRoute(3 * MILE).map((p, i) => ({ ...p, timestamp: i % 2 ? "not-a-time" : p.timestamp }));
    const rec = record(bad);
    expect(rec["1mi"]).toBeNull();
    const facts = { distanceMiles: 3, durationSeconds: 1770 };
    expect(assessBestEffortsCache(rec, true, facts).recompute).toBe(true);
    const twice = record(bad, true, { verificationAttempts: BEST_EFFORTS_VERIFICATION.maxAttempts });
    expect(assessBestEffortsCache(twice, true, facts).recompute).toBe(false);
    const missingTimes = steadyRoute(3 * MILE).map(p => ({ ...p, timestamp: "" }));
    expect(record(missingTimes)["1mi"]).toBeNull();
  });
});

describe("invalid stored values and route point-count changes", () => {
  const full = steadyRoute(6.5 * MILE), facts = { distanceMiles: 6.5, durationSeconds: full.length };
  it("non-finite or non-numeric stored values are flagged on read and force a recompute", () => {
    const parsed = parseStoredBestEfforts({ ...record(full), "5k": Number.NaN, "10k": "fast" })!;
    expect(parsed.invalidStoredValues).toBe(true); expect(parsed["5k"]).toBeNull();
    expect(assessBestEffortsCache(parsed, true, facts)).toMatchObject({ state: "invalid_recoverable", recompute: true });
    expect(parseStoredBestEfforts({ ...record(full) })!.invalidStoredValues).toBeUndefined();
    expect(parseStoredBestEfforts("bad")).toBeUndefined(); expect(parseStoredBestEfforts(null)).toBeUndefined();
  });
  it("impossible values (implausible pace, or a longer distance faster than a shorter one) are invalid", () => {
    const base = record(full);
    expect(assessBestEffortsCache({ ...base, "5k": 100 }, true, facts).state).toBe("invalid_recoverable");
    expect(assessBestEffortsCache({ ...base, "10k": (base["5k"] as number) - 1 }, true, facts).state).toBe("invalid_recoverable");
    expect(assessBestEffortsCache({ ...base, "5k": 5000 * 3 }, true, facts).state).toBe("invalid_recoverable");
  });
  it("optional new metadata round-trips; unknown or bad counters are dropped", () => {
    const p = parseStoredBestEfforts({ ...record(full, true, { verificationAttempts: 1 }) })!;
    expect(p.verificationAttempts).toBe(1); expect(p.computedFromRouteDistanceMeters).toBeGreaterThan(0);
    const bad = parseStoredBestEfforts({ ...record(full), verificationAttempts: -2, computedFromRouteDistanceMeters: "x" })!;
    expect(bad).not.toHaveProperty("verificationAttempts"); expect(bad).not.toHaveProperty("computedFromRouteDistanceMeters");
  });
  it("a route that GREW since the record was computed (more points than stored) is detected from the stored count vs duration", () => {
    const stored = record(full.slice(0, 500));
    expect(assessBestEffortsCache(stored, true, facts).state).toBe("suspicious_recoverable");
    expect(assessBestEffortsCache(record(full), true, facts).state).toBe("valid_current");
  });
});

describe("never replace better data with worse (stale-over-fresh)", () => {
  const full = steadyRoute(6.5 * MILE);
  const good = record(full);
  it("keeps a current complete-route record over an incomplete or smaller recomputation", () => {
    expect(shouldReplaceBestEfforts(good, record(full, false))).toBe(false);
    expect(shouldReplaceBestEfforts(good, record(full.slice(0, 300)))).toBe(false);
  });
  it("replaces missing, stale, incomplete, invalid or truncated records with a complete recomputation", () => {
    expect(shouldReplaceBestEfforts(undefined, good)).toBe(true);
    expect(shouldReplaceBestEfforts({ ...good, computationVersion: 1 }, good)).toBe(true);
    expect(shouldReplaceBestEfforts(record(full.slice(0, 300), false), good)).toBe(true);
    expect(shouldReplaceBestEfforts({ ...good, "5k": Number.NaN as unknown as number }, good)).toBe(true);
    expect(shouldReplaceBestEfforts(record(full.slice(0, 300)), good)).toBe(true);        // more points than the truncated record
  });
  it("an equal recomputation changes nothing", () => { expect(shouldReplaceBestEfforts(good, record(full))).toBe(true); });
});
