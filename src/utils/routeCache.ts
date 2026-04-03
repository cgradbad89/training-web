/**
 * Module-level cache for route points.
 * Persists across page navigations within the same session.
 * Keyed by workoutId.
 */

import { type RoutePoint, fetchRoutePoints } from "@/services/routes";

const cache = new Map<string, RoutePoint[]>();
const inFlight = new Map<string, Promise<RoutePoint[]>>();

/**
 * Get route points from cache or fetch them.
 * Deduplicates concurrent requests for the same workoutId.
 */
export async function getRoutePoints(
  uid: string,
  workoutId: string
): Promise<RoutePoint[]> {
  if (cache.has(workoutId)) {
    return cache.get(workoutId)!;
  }

  if (inFlight.has(workoutId)) {
    return inFlight.get(workoutId)!;
  }

  const promise = fetchRoutePoints(uid, workoutId)
    .then((points) => {
      cache.set(workoutId, points);
      inFlight.delete(workoutId);
      return points;
    })
    .catch((err) => {
      inFlight.delete(workoutId);
      throw err;
    });

  inFlight.set(workoutId, promise);
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
  const needed = workoutIds.filter(
    (id) => !cache.has(id) && !inFlight.has(id)
  );
  if (needed.length === 0) return;

  for (let i = 0; i < needed.length; i += concurrency) {
    const batch = needed.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map((id) => getRoutePoints(uid, id).catch(() => {}))
    );
    if (i + concurrency < needed.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** Check if a workoutId is already cached */
export function isRouteCached(workoutId: string): boolean {
  return cache.has(workoutId);
}

/**
 * Fetch just the first route point for a workout (start coordinate).
 * Uses the existing cache — if route is already cached, reads from it.
 * Otherwise fetches just the first document from the route subcollection.
 */
export async function getRouteStartPoint(
  uid: string,
  workoutId: string
): Promise<{ lat: number; lng: number } | null> {
  // If full route is cached, use its first point
  if (cache.has(workoutId)) {
    const pts = cache.get(workoutId)!;
    if (pts.length > 0) return { lat: pts[0].lat, lng: pts[0].lng };
    return null;
  }

  // Otherwise fetch just the first route point from Firestore
  try {
    const { collection, query, orderBy, limit, getDocs } = await import(
      "firebase/firestore"
    );
    const { db } = await import("@/lib/firebase");
    const routeRef = collection(
      db,
      `users/${uid}/healthWorkouts/${workoutId}/route`
    );
    const q = query(routeRef, orderBy("__name__"), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const data = snap.docs[0].data();
    return { lat: data.lat, lng: data.lng };
  } catch {
    return null;
  }
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
