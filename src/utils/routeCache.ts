/**
 * Module-level cache for route points.
 * Persists across page navigations within the same session.
 * UID-scoped, with an auth-session epoch so cleared in-flight work cannot
 * repopulate memory. No custom persistence or route freshness policy.
 */

import { type RoutePoint, fetchRoutePoints } from "@/services/routes";
import { collection, query, orderBy, limit, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";

const cache = new Map<string, RoutePoint[]>();
const inFlight = new Map<string, Promise<RoutePoint[]>>();
type RouteStart = { lat: number; lng: number };
// One Routes view uses at most 500 raw workouts. Keep only small coordinates,
// with LRU eviction; empty/failed reads are not cached (ingestion may be pending).
const MAX_ROUTE_STARTS = 500;
const startCache = new Map<string, RouteStart>();
const startInFlight = new Map<string, Promise<RouteStart | null>>();
let sessionUid: string | null = null;
let sessionEpoch = 0;

/** Snapshot for multi-batch consumers: retirement must stop subsequent reads. */
export function getRouteCacheEpoch(): number {
  return sessionEpoch;
}

/** Explicit tuple encoding avoids collisions and requires UID at every read. */
function routeKey(uid: string, workoutId: string): string {
  return JSON.stringify([uid, workoutId]);
}

/** Invalidates pending owners as well as settled data (including same-UID login). */
export function clearRouteCache(): void {
  sessionEpoch += 1;
  cache.clear();
  inFlight.clear();
  startCache.clear();
  startInFlight.clear();
}

/** Called by the existing auth observer, before exposing the next identity.
 * Repeated observations of the same authorized UID retain navigation reuse;
 * a signed-out observation followed by that UID starts a fresh session. */
export function setRouteCacheSession(uid: string | null): void {
  if (uid !== null && uid === sessionUid) return;
  clearRouteCache();
  sessionUid = uid;
}

/**
 * Get route points from cache or fetch them.
 * Deduplicates concurrent requests for the same UID/workout in this session.
 */
export async function getRoutePoints(
  uid: string,
  workoutId: string
): Promise<RoutePoint[]> {
  const key = routeKey(uid, workoutId);
  const epoch = sessionEpoch;
  if (cache.has(key)) {
    return cache.get(key)!;
  }

  if (inFlight.has(key)) {
    return inFlight.get(key)!;
  }

  const promise = fetchRoutePoints(uid, workoutId)
    .then((points) => {
      if (epoch === sessionEpoch) cache.set(key, points);
      return points;
    })
    .finally(() => {
      // A retired request cannot delete a replacement request for the same key.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Prefetch route points for a list of workoutIds in the background.
 * Respects concurrency limit to avoid hammering Firestore.
 * Silent — errors are caught and ignored.
 */
export async function prefetchRoutes(
  uid: string,
  workoutIds: string[],
  concurrency = 3
): Promise<void> {
  const epoch = sessionEpoch;
  const needed = workoutIds.filter(
    (id) => !cache.has(routeKey(uid, id)) && !inFlight.has(routeKey(uid, id))
  );
  if (needed.length === 0) return;

  for (let i = 0; i < needed.length; i += concurrency) {
    if (epoch !== sessionEpoch) return;
    const batch = needed.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map((id) => getRoutePoints(uid, id).catch(() => {}))
    );
    if (i + concurrency < needed.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** Check only this UID's current-session memory. UID cannot be omitted. */
export function isRouteCached(uid: string, workoutId: string): boolean {
  return cache.has(routeKey(uid, workoutId));
}

/**
 * Fetch just the first route point for a workout (start coordinate).
 * Full GPS takes precedence; a coordinate never substitutes for full GPS.
 * Nonempty starts survive same-session navigation, with identical work shared.
 * The auth observer retires both maps and pending owners with the GPS epoch.
 */
export async function getRouteStartPoint(
  uid: string,
  workoutId: string
): Promise<{ lat: number; lng: number } | null> {
  // If full route is cached, use its first point
  const key = routeKey(uid, workoutId);
  if (cache.has(key)) {
    const pts = cache.get(key)!;
    if (pts.length > 0) return { lat: pts[0].lat, lng: pts[0].lng };
    return null;
  }

  const cached = startCache.get(key);
  if (cached) {
    startCache.delete(key);
    startCache.set(key, cached);
    return cached;
  }
  const pending = startInFlight.get(key);
  if (pending) return pending;

  const epoch = sessionEpoch;
  const promise = (async (): Promise<RouteStart | null> => {
    try {
      // Defer work until its promise is registered, allowing synchronous
      // retirement to prevent a queued old-session query from starting.
      await Promise.resolve();
      if (epoch !== sessionEpoch) return null;
      const routeRef = collection(
        db,
        `users/${uid}/healthWorkouts/${workoutId}/route`
      );
      const q = query(routeRef, orderBy("__name__"), limit(1));
      const snap = await getDocs(q);
      if (epoch !== sessionEpoch || snap.empty) return null;
      const data = snap.docs[0].data();
      if (!Number.isFinite(data.lat) || !Number.isFinite(data.lng)) return null;
      const start = { lat: data.lat, lng: data.lng };
      startCache.set(key, start);
      if (startCache.size > MAX_ROUTE_STARTS) {
        startCache.delete(startCache.keys().next().value!);
      }
      return start;
    } catch {
      return null;
    }
  })().finally(() => {
    // Late old work must not remove a replacement request for this same key.
    if (startInFlight.get(key) === promise) startInFlight.delete(key);
  });
  startInFlight.set(key, promise);
  return promise;
}

/** Haversine distance in meters between two lat/lng points */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
