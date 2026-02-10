import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import dangerZonesData from "@/data/danger-zones.json";

type DangerZoneFeature = GeoJSON.Feature<GeoJSON.Polygon>;

const dangerZones: DangerZoneFeature[] =
  dangerZonesData.features as DangerZoneFeature[];

/**
 * Check if a point (lat, lng) falls inside any danger zone.
 */
export function isInDangerZone(lat: number, lng: number): boolean {
  const pt = point([lng, lat]); // GeoJSON uses [lng, lat]
  return dangerZones.some((zone) => booleanPointInPolygon(pt, zone));
}

/**
 * Filter out waypoints that fall in danger zones.
 * Returns only safe waypoints.
 */
export function filterSafeWaypoints(
  waypoints: [number, number][]
): [number, number][] {
  return waypoints.filter(([lat, lng]) => !isInDangerZone(lat, lng));
}

/**
 * Check if any segment of a route passes through danger zones.
 * Samples points along the route geometry to check.
 */
export function routePassesThroughDangerZone(
  geometry: GeoJSON.LineString
): boolean {
  // Sample every 10th coordinate for performance
  const coords = geometry.coordinates;
  const step = Math.max(1, Math.floor(coords.length / 50));

  for (let i = 0; i < coords.length; i += step) {
    const [lng, lat] = coords[i];
    if (isInDangerZone(lat, lng)) {
      return true;
    }
  }
  return false;
}

/**
 * Get all danger zones as GeoJSON for frontend display.
 */
export function getDangerZones(): GeoJSON.FeatureCollection {
  return dangerZonesData as GeoJSON.FeatureCollection;
}
