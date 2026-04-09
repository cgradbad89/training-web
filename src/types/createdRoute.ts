/**
 * CreatedRoute — a user-drawn route stored at
 * users/{uid}/createdRoutes/{routeId}
 */

export interface CreatedRouteWaypoint {
  lat: number;
  lng: number;
}

export interface CreatedRoute {
  id: string;
  name: string;
  waypoints: CreatedRouteWaypoint[];
  /**
   * Full Directions-API-snapped polyline for the route.
   * Flattened from per-segment paths into a single array so it can be
   * passed directly to a <Polyline>. Optional for backwards
   * compatibility with routes created before snappedPath was persisted.
   */
  snappedPath?: CreatedRouteWaypoint[];
  distanceMiles: number;
  createdAt: Date;
  updatedAt: Date;
}
