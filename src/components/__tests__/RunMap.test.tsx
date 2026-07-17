import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Capture the props <GoogleMap> is instantiated with. This is the whole point
// of the test: a blank map in production came from center/zoom never being
// passed, so we assert they arrive defined and correct.
const googleMapProps: Array<Record<string, unknown>> = [];

vi.mock("@react-google-maps/api", () => ({
  GoogleMap: (props: Record<string, unknown>) => {
    googleMapProps.push(props);
    return React.createElement(
      "div",
      { "data-testid": "google-map" },
      props.children as React.ReactNode
    );
  },
  Polyline: () => null,
  Marker: () => null,
}));

// Force the loader into the "loaded" branch and pass children straight
// through, so RunMapInner reaches the <GoogleMap> render.
vi.mock("@/components/GoogleMapsProvider", () => ({
  GoogleMapsProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useGoogleMaps: () => ({ isLoaded: true, loadError: undefined }),
}));

// Marker icons reference google.maps.SymbolPath at render time; provide a stub
// so element creation doesn't throw. (Marker itself is mocked to render null.)
(globalThis as unknown as { google: unknown }).google = {
  maps: {
    SymbolPath: { CIRCLE: 0 },
    LatLngBounds: class {
      extend() {}
    },
  },
};

import RunMap from "@/components/RunMap";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  googleMapProps.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RunMap", () => {
  const points = [
    { lat: 37.1, lng: -122.1 },
    { lat: 37.2, lng: -122.2 },
    { lat: 37.3, lng: -122.3 },
  ];

  it("instantiates <GoogleMap> with a defined center and zoom (raw points path)", () => {
    act(() => {
      root.render(<RunMap points={points} />);
    });

    expect(container.querySelector('[data-testid="google-map"]')).not.toBeNull();
    expect(googleMapProps).toHaveLength(1);

    const { center, zoom } = googleMapProps[0];
    // The bug was center/zoom being undefined — assert they are present.
    expect(center).toBeDefined();
    expect(zoom).toBeDefined();
    // center should be the first point of the active path.
    expect(center).toEqual({ lat: 37.1, lng: -122.1 });
    expect(typeof zoom).toBe("number");
    expect(zoom as number).toBeGreaterThan(0);
  });

  it("centers on the first simplifiedPath point when a cached path is supplied", () => {
    const simplifiedPath = [
      { lat: 40.5, lng: -74.5 },
      { lat: 40.6, lng: -74.6 },
    ];

    act(() => {
      root.render(<RunMap points={[]} simplifiedPath={simplifiedPath} />);
    });

    expect(googleMapProps).toHaveLength(1);
    const { center, zoom } = googleMapProps[0];
    expect(center).toEqual({ lat: 40.5, lng: -74.5 });
    expect(zoom).toBeDefined();
  });
});
