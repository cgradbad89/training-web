"use client";

import React, { useCallback, useMemo } from "react";
import { GoogleMap, Polyline, Marker } from "@react-google-maps/api";

import { type RoutePoint } from "@/services/routes";
import { useGoogleMaps } from "@/components/GoogleMapsProvider";

interface RunMapProps {
  points: RoutePoint[];
  className?: string;
}

export default function RunMap({ points, className = "" }: RunMapProps) {
  const { isLoaded, loadError } = useGoogleMaps();

  const path = useMemo(
    () => points.map((p) => ({ lat: p.lat, lng: p.lng })),
    [points]
  );

  const start = path[0];
  const end = path[path.length - 1];

  const onLoad = useCallback(
    (map: google.maps.Map) => {
      if (path.length === 0) return;
      const bounds = new google.maps.LatLngBounds();
      path.forEach((p) => bounds.extend(p));
      map.fitBounds(bounds, 30);
    },
    [path]
  );

  if (loadError) {
    return (
      <div
        className={`w-full h-64 sm:h-96 flex items-center justify-center bg-gray-100 text-sm text-gray-500 ${className}`}
      >
        Failed to load map
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div
        className={`w-full h-64 sm:h-96 flex items-center justify-center bg-gray-100 ${className}`}
      >
        <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  if (points.length === 0) {
    return <div className={`w-full h-64 sm:h-96 ${className}`} />;
  }

  return (
    <div className={`w-full h-64 sm:h-96 ${className}`}>
      <GoogleMap
        mapContainerStyle={{ width: "100%", height: "100%" }}
        onLoad={onLoad}
        options={{
          scrollwheel: false,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        }}
      >
        <Polyline
          path={path}
          options={{
            strokeColor: "#007AFF",
            strokeWeight: 4,
            strokeOpacity: 0.9,
          }}
        />
        {start && (
          <Marker
            position={start}
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: "#34C759",
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
            }}
            zIndex={2}
          />
        )}
        {end && (
          <Marker
            position={end}
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: "#FF3B30",
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
            }}
            zIndex={2}
          />
        )}
      </GoogleMap>
    </div>
  );
}
