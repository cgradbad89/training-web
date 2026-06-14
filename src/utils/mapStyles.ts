/**
 * Shared dark style for every Google Maps instance in the app (run detail map,
 * created-route detail map, route-draw tool). A single constant so all maps
 * stay visually identical and can never drift.
 *
 * Hex values mirror the app's DARK surface palette from globals.css (the
 * `@media (prefers-color-scheme: dark)` token block) — a Google Maps `styles`
 * array must be literal hex (it cannot read CSS variables at runtime), so the
 * dark token values are baked in here:
 *   --background  #0f172a  (darkest — water, label halos)
 *   --card        #1e293b  (base land geometry)
 *   --border      #334155  (administrative boundaries)
 *   --textSecondary #94a3b8 (label text)
 * Road/park/highway shades are interpolated within the same slate family so
 * roads stay slightly lighter than the land and remain readable, parks read as
 * a muted grey-blue (NOT green), and water sits darkest. The result is a
 * subtle, desaturated dark map — not a high-contrast or black theme.
 *
 * Applied via the GoogleMap `options.styles` prop. NOT a Cloud-console mapId
 * (which would lock styling to the console and is out of scope) — none of the
 * app's maps use a mapId, so a runtime styles array is valid for all of them.
 */
export const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  // Base geometry + global label treatment.
  { elementType: "geometry", stylers: [{ color: "#1e293b" }] }, // --card
  { elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] }, // --textSecondary
  { elementType: "labels.text.stroke", stylers: [{ color: "#0f172a" }] }, // --background halo
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },

  // Administrative boundaries → --border.
  {
    featureType: "administrative",
    elementType: "geometry",
    stylers: [{ color: "#334155" }],
  },
  {
    featureType: "administrative.land_parcel",
    stylers: [{ visibility: "off" }],
  },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#aab6c7" }],
  },

  // Points of interest — suppress clutter; keep parks as a muted grey-blue.
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  {
    featureType: "poi.park",
    elementType: "geometry",
    stylers: [{ color: "#233044" }], // slightly lighter than water, NOT green
  },

  // Roads — slightly lighter than the land so they read clearly.
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#2a3850" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#1a2336" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#8a99ad" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#3a4a66" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry.stroke",
    stylers: [{ color: "#222d44" }],
  },

  // Transit — off (route maps don't need it).
  { featureType: "transit", stylers: [{ visibility: "off" }] },

  // Water → darkest surface.
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#0d1626" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#5b6b84" }],
  },
];
