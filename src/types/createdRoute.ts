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
  distanceMiles: number;
  createdAt: Date;
  updatedAt: Date;
}
