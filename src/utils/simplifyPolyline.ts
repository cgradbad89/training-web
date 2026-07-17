/**
 * Douglas–Peucker polyline simplification for the run-detail map.
 *
 * The full ~1 Hz GPS route can be several thousand points; the map only needs
 * enough vertices to draw a visually identical polyline. This reduces the
 * point count (typically 10–30×) so a simplified path can be cached on the
 * workout doc and rendered without reading the full `route` subcollection.
 *
 * Distances use a planar (equirectangular) approximation projected around the
 * route's first latitude. Run routes are local (a few km across), so the
 * distortion over that span is negligible for a metre-scale tolerance.
 *
 * IMPORTANT: this is for DISPLAY ONLY. Never simplify points before computing
 * GAP, mile splits, or zone breakdowns — those rely on full-resolution
 * geometry (e.g. GAP's 25 m baseline resampling to damp GPS noise).
 */

export interface SimplifiedPathPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;

/** Project lat/lng to local planar metres around a reference latitude. */
function projectX(lng: number, cosRefLat: number): number {
  return lng * DEG_TO_RAD * cosRefLat * EARTH_RADIUS_M;
}
function projectY(lat: number): number {
  return lat * DEG_TO_RAD * EARTH_RADIUS_M;
}

/**
 * Perpendicular distance (metres) from point P to the INFINITE line through
 * A and B — the classic Douglas–Peucker measure (not clamped to the segment).
 * When A and B coincide, falls back to the straight-line distance P→A.
 */
function perpendicularDistanceMeters(
  p: SimplifiedPathPoint,
  a: SimplifiedPathPoint,
  b: SimplifiedPathPoint,
  cosRefLat: number
): number {
  const px = projectX(p.lng, cosRefLat);
  const py = projectY(p.lat);
  const ax = projectX(a.lng, cosRefLat);
  const ay = projectY(a.lat);
  const bx = projectX(b.lng, cosRefLat);
  const by = projectY(b.lat);

  const dx = bx - ax;
  const dy = by - ay;
  const segLen2 = dx * dx + dy * dy;

  if (segLen2 === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }

  const cross = Math.abs(dx * (ay - py) - (ax - px) * dy);
  return cross / Math.sqrt(segLen2);
}

/**
 * Simplify a polyline with the Douglas–Peucker algorithm.
 *
 * The first and last points are ALWAYS kept exactly. Interior points are kept
 * only when their perpendicular distance to the current segment exceeds
 * `toleranceMeters`. Iterative (explicit stack) so a dense route can't blow the
 * call stack. Order is preserved.
 *
 * @param points          Ordered path points (lat/lng).
 * @param toleranceMeters Larger tolerance → fewer points. `<= 0` disables
 *                        simplification (returns a copy of every point).
 */
export function simplifyPolyline(
  points: { lat: number; lng: number }[],
  toleranceMeters: number
): SimplifiedPathPoint[] {
  const n = points.length;
  if (n <= 2) return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  if (!(toleranceMeters > 0)) {
    return points.map((p) => ({ lat: p.lat, lng: p.lng }));
  }

  const cosRefLat = Math.cos(points[0].lat * DEG_TO_RAD);

  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistanceMeters(
        points[i],
        points[first],
        points[last],
        cosRefLat
      );
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > toleranceMeters && idx !== -1) {
      keep[idx] = true;
      stack.push([first, idx]);
      stack.push([idx, last]);
    }
  }

  const out: SimplifiedPathPoint[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push({ lat: points[i].lat, lng: points[i].lng });
  }
  return out;
}

/**
 * Parse a Firestore-stored `simplifiedPath` value back to a point array.
 * Returns undefined for anything that isn't a >= 2 length array of finite
 * lat/lng pairs (a 1-point path can't draw a polyline).
 */
export function parseSimplifiedPath(
  value: unknown
): SimplifiedPathPoint[] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const out: SimplifiedPathPoint[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    const lat = r.lat;
    const lng = r.lng;
    if (
      typeof lat !== "number" ||
      !Number.isFinite(lat) ||
      typeof lng !== "number" ||
      !Number.isFinite(lng)
    ) {
      return undefined;
    }
    out.push({ lat, lng });
  }
  return out;
}
