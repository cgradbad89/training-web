import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { CreatedRoute, CreatedRouteWaypoint } from "@/types/createdRoute";

function colRef(uid: string) {
  return collection(db, "users", uid, "createdRoutes");
}

function docRef(uid: string, routeId: string) {
  return doc(db, "users", uid, "createdRoutes", routeId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCreatedRoute(id: string, data: Record<string, any>): CreatedRoute {
  const ts = (v: unknown) => {
    if (v && typeof v === "object" && "toDate" in v) {
      return (v as { toDate: () => Date }).toDate();
    }
    return new Date();
  };
  const snapped = data.snappedPath as CreatedRouteWaypoint[] | undefined;
  return {
    id,
    name: (data.name as string) ?? "Untitled Route",
    waypoints: (data.waypoints as CreatedRouteWaypoint[]) ?? [],
    snappedPath: snapped && snapped.length > 0 ? snapped : undefined,
    distanceMiles: (data.distanceMiles as number) ?? 0,
    createdAt: ts(data.createdAt),
    updatedAt: ts(data.updatedAt),
  };
}

export async function fetchCreatedRoutes(uid: string): Promise<CreatedRoute[]> {
  const q = query(colRef(uid), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    toCreatedRoute(d.id, d.data() as Record<string, unknown>)
  );
}

export async function saveCreatedRoute(
  uid: string,
  route: {
    name: string;
    waypoints: CreatedRouteWaypoint[];
    snappedPath?: CreatedRouteWaypoint[];
    distanceMiles: number;
  }
): Promise<string> {
  const ref = doc(colRef(uid));
  const payload: Record<string, unknown> = {
    name: route.name,
    waypoints: route.waypoints,
    distanceMiles: route.distanceMiles,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (route.snappedPath && route.snappedPath.length > 0) {
    payload.snappedPath = route.snappedPath;
  }
  await setDoc(ref, payload);
  return ref.id;
}

export async function updateCreatedRoute(
  uid: string,
  routeId: string,
  data: Partial<
    Pick<CreatedRoute, "name" | "waypoints" | "snappedPath" | "distanceMiles">
  >
): Promise<void> {
  await updateDoc(docRef(uid, routeId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteCreatedRoute(
  uid: string,
  routeId: string
): Promise<void> {
  await deleteDoc(docRef(uid, routeId));
}
