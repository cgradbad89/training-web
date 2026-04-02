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
