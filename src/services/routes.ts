import {
  collection,
  getDocsFromServer,
  limit,
  orderBy,
  query,
  startAfter,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

export const ROUTE_PAGE_SIZE = 250;
export const DEFAULT_ROUTE_DOCUMENT_LIMIT = 25_000;

export class RouteReadLimitExceededError extends Error {
  constructor(readonly documentLimit: number) {
    super(`The route exceeds the ${documentLimit.toLocaleString("en-US")}-document detail limit. The complete route was not returned.`);
    this.name = "RouteReadLimitExceededError";
  }
}

export class RouteReadCancelledError extends Error {
  constructor() { super("The route read belongs to a retired session."); this.name = "AbortError"; }
}

export interface RoutePoint {
  index: number;
  lat: number;
  lng: number;
  altitude: number;
  timestamp: string; // ISO string
  speed: number | null;
  /** Per-point heart rate in bpm (added iOS-side, commit 84dfbf3). Null when absent. */
  hr: number | null;
}

function docToRoutePoint(data: Record<string, unknown>): RoutePoint {
  const ts = data.timestamp as { toDate?: () => Date } | null;
  return {
    index: (data.index as number) ?? 0,
    lat: (data.lat as number) ?? 0,
    lng: (data.lng as number) ?? 0,
    altitude: (data.altitude as number) ?? 0,
    timestamp: ts?.toDate?.()?.toISOString() ?? "",
    speed: (data.speed as number | null) ?? null,
    hr: (data.hr as number | null) ?? null,
  };
}

export async function fetchRoutePoints(
  uid: string,
  workoutId: string,
  options: { isCurrent?: () => boolean; maxDocuments?: number } = {}
): Promise<RoutePoint[]> {
  const maximum = options.maxDocuments ?? DEFAULT_ROUTE_DOCUMENT_LIMIT;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) {
    throw new RangeError("Route document limit must be 1–100,000.");
  }
  const assertCurrent = () => {
    if (options.isCurrent?.() === false) throw new RouteReadCancelledError();
  };
  const ref = collection(
    db,
    "users",
    uid,
    "healthWorkouts",
    workoutId,
    "route"
  );
  const points: RoutePoint[] = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  // Preserve the existing index ordering. A one-document overflow probe proves
  // exhaustion at the exact cap; overflow rejects the whole result, never a
  // truncated series that a caller could persist as a complete cache.
  for (;;) {
    assertCurrent();
    const size = Math.min(ROUTE_PAGE_SIZE, maximum - points.length + 1);
    const page: QuerySnapshot<DocumentData> = await getDocsFromServer(query(ref, orderBy("index", "asc"),
      ...(cursor ? [startAfter(cursor)] : []), limit(size)));
    assertCurrent();
    if (points.length + page.docs.length > maximum) throw new RouteReadLimitExceededError(maximum);
    points.push(...page.docs.map(d => docToRoutePoint(d.data() as Record<string, unknown>)));
    if (page.docs.length < size) return points;
    cursor = page.docs[page.docs.length - 1];
  }
}
