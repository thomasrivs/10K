import { isInDangerZone, routePassesThroughDangerZone } from "./danger-zones";

const OSRM_BASE_URL = "https://router.project-osrm.org";
const MAX_WAYPOINT_RETRIES = 3;

const CUL_DE_SAC_THRESHOLD_M = 10; // Max 10m of retracing allowed
const MAX_ATTEMPTS = 20;

export interface TurnManeuver {
  lat: number;
  lng: number;
  instruction: string;
  type: "left" | "right" | "slight_left" | "slight_right" | "uturn";
}

interface RouteResult {
  distance: number; // meters
  duration: number; // seconds
  geometry: GeoJSON.LineString;
  waypoints: [number, number][];
  stepsEstimate: number;
  maneuvers: TurnManeuver[];
}

interface CandidateRoute {
  distance: number;
  geometry: GeoJSON.LineString;
  waypoints: [number, number][];
  maneuvers: TurnManeuver[];
  score: number;
}

/**
 * Haversine distance between two [lng, lat] coordinate pairs (in meters).
 */
function haversineM(
  lng1: number, lat1: number,
  lng2: number, lat2: number
): number {
  const R = 6371e3;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Generate a single waypoint at a given angle and radius from center.
 * Tight jitter (±5% radius, ±0.05 rad angle) to keep a round shape.
 */
function generateSingleWaypoint(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  angle: number
): [number, number] {
  const latDegPerKm = 1 / 111.32;
  const lngDegPerKm = 1 / (111.32 * Math.cos((centerLat * Math.PI) / 180));

  const r = radiusKm * (0.95 + Math.random() * 0.1);
  const jitter = (Math.random() - 0.5) * 0.05;

  const lat = centerLat + r * latDegPerKm * Math.sin(angle + jitter);
  const lng = centerLng + r * lngDegPerKm * Math.cos(angle + jitter);

  return [lat, lng];
}

/**
 * Generate safe waypoints in a loop around a center point.
 * Avoids placing waypoints inside danger zones.
 */
function generateSafeWaypoints(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  count: number
): [number, number][] {
  const waypoints: [number, number][] = [];
  const baseAngleOffset = Math.random() * 2 * Math.PI;

  for (let i = 0; i < count; i++) {
    const angle = baseAngleOffset + (i / count) * 2 * Math.PI;

    let waypoint: [number, number] | null = null;

    for (let retry = 0; retry < MAX_WAYPOINT_RETRIES; retry++) {
      const candidate = generateSingleWaypoint(
        centerLat,
        centerLng,
        radiusKm,
        angle
      );

      if (!isInDangerZone(candidate[0], candidate[1])) {
        waypoint = candidate;
        break;
      }
    }

    if (!waypoint) {
      waypoint = generateSingleWaypoint(
        centerLat,
        centerLng,
        radiusKm,
        angle + 0.5
      );
    }

    waypoints.push(waypoint);
  }

  return waypoints;
}

/**
 * Call OSRM route service to get a walking route through waypoints.
 */
const TURN_TYPES = new Set(["turn", "end of road", "fork", "roundabout turn"]);

async function callOSRM(
  start: [number, number],
  waypoints: [number, number][]
): Promise<{
  distance: number;
  duration: number;
  geometry: GeoJSON.LineString;
  maneuvers: TurnManeuver[];
}> {
  const allPoints = [start, ...waypoints, start];
  const coordString = allPoints
    .map(([lat, lng]) => `${lng},${lat}`)
    .join(";");

  const url = `${OSRM_BASE_URL}/route/v1/foot/${coordString}?overview=full&geometries=geojson&continue_straight=true&steps=true`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM API error: ${response.status}`);
  }

  const data = await response.json();

  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
    throw new Error(`OSRM returned no route: ${data.code}`);
  }

  const route = data.routes[0];

  // Extract turn maneuvers from all legs/steps
  const maneuvers: TurnManeuver[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const m = step.maneuver;
      if (!TURN_TYPES.has(m.type)) continue;
      const mod: string = m.modifier ?? "";
      let type: TurnManeuver["type"] | null = null;
      let instruction = "";
      if (mod.includes("left")) {
        type = mod === "slight left" ? "slight_left" : "left";
        instruction = mod === "slight left" ? "Légèrement à gauche" : "Tournez à gauche";
      } else if (mod.includes("right")) {
        type = mod === "slight right" ? "slight_right" : "right";
        instruction = mod === "slight right" ? "Légèrement à droite" : "Tournez à droite";
      } else if (mod === "uturn") {
        type = "uturn";
        instruction = "Faites demi-tour";
      }
      if (type) {
        maneuvers.push({ lat: m.location[1], lng: m.location[0], instruction, type });
      }
    }
  }

  return {
    distance: route.distance,
    duration: route.duration,
    geometry: route.geometry,
    maneuvers,
  };
}

/**
 * Cul-de-sac / backtracking detection.
 *
 * Principle: a cul-de-sac happens when the route visits a location,
 * goes somewhere, and comes back to (nearly) the same spot.
 * This means two points that are close geographically (<10m) but
 * far apart in the route sequence.
 *
 * We use a spatial grid to efficiently find nearby revisits.
 * The grid cell size is smaller than the threshold so we only need
 * to check neighboring cells.
 *
 * Excludes the loop closure zone (first/last 5%) where the route
 * naturally returns to the start.
 *
 * Returns true if any cul-de-sac is detected.
 */
function hasCulDeSac(geometry: GeoJSON.LineString): boolean {
  const coords = geometry.coordinates;
  const total = coords.length;
  if (total < 20) return false;

  // Skip loop closure zone (first/last 5%)
  const zoneStart = Math.floor(total * 0.05);
  const zoneEnd = total - Math.floor(total * 0.05);

  // Grid cell size ~5m (half of threshold for neighbor checking)
  const CELL_DEG = 0.000045; // ~5m

  // Minimum sequence gap to consider as a cul-de-sac.
  // Points that are very close in sequence are just the route following
  // a wide street or curving — we need at least ~15 points gap.
  const MIN_SEQ_GAP = 15;

  // Build spatial index: grid cell -> list of indices
  const grid = new Map<string, number[]>();

  for (let i = zoneStart; i < zoneEnd; i++) {
    const cx = Math.floor(coords[i][0] / CELL_DEG);
    const cy = Math.floor(coords[i][1] / CELL_DEG);
    const key = `${cx},${cy}`;

    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(i);
  }

  // For each point in the middle zone, check neighboring cells
  // for points that are close geographically but far in sequence
  for (let i = zoneStart; i < zoneEnd; i++) {
    const cx = Math.floor(coords[i][0] / CELL_DEG);
    const cy = Math.floor(coords[i][1] / CELL_DEG);

    // Check 3x3 neighborhood
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighborKey = `${cx + dx},${cy + dy}`;
        const neighbors = grid.get(neighborKey);
        if (!neighbors) continue;

        for (const j of neighbors) {
          // Must be far enough apart in sequence
          if (Math.abs(j - i) < MIN_SEQ_GAP) continue;

          // Check actual distance
          const dist = haversineM(
            coords[i][0], coords[i][1],
            coords[j][0], coords[j][1]
          );

          if (dist < CUL_DE_SAC_THRESHOLD_M) {
            return true; // Cul-de-sac detected
          }
        }
      }
    }
  }

  return false;
}

/**
 * Self-intersection detection.
 *
 * Checks if any two non-adjacent segments of the route cross each other.
 * Uses a sampled approach (every Nth point) to keep it fast on large geometries.
 * Excludes the loop closure zone (first/last 5%) where start≈end.
 *
 * Returns true if any crossing is detected.
 */
function hasSelfIntersection(geometry: GeoJSON.LineString): boolean {
  const coords = geometry.coordinates;
  const total = coords.length;
  if (total < 40) return false;

  // Sample every Nth point to build simplified segments
  const SAMPLE = Math.max(1, Math.floor(total / 200));
  const sampled: [number, number][] = [];
  for (let i = 0; i < total; i += SAMPLE) {
    sampled.push([coords[i][0], coords[i][1]]);
  }
  // Ensure last point is included
  sampled.push([coords[total - 1][0], coords[total - 1][1]]);

  const n = sampled.length;
  // Skip closure zone: first/last 5% of sampled points
  const zoneSkip = Math.max(2, Math.floor(n * 0.05));

  // ccw helper
  const cross = (
    ax: number, ay: number,
    bx: number, by: number,
    cx: number, cy: number
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = sampled[i];
    const [bx, by] = sampled[i + 1];

    // Only check segments far enough apart (skip adjacent + closure zone)
    for (let j = i + 2; j < n - 1; j++) {
      // Skip closure zone overlap
      if (i < zoneSkip && j >= n - 1 - zoneSkip) continue;
      if (j < zoneSkip && i >= n - 1 - zoneSkip) continue;

      const [cx, cy] = sampled[j];
      const [dx, dy] = sampled[j + 1];

      const d1 = cross(ax, ay, bx, by, cx, cy);
      const d2 = cross(ax, ay, bx, by, dx, dy);
      const d3 = cross(cx, cy, dx, dy, ax, ay);
      const d4 = cross(cx, cy, dx, dy, bx, by);

      if (d1 * d2 < 0 && d3 * d4 < 0) {
        return true; // Segments cross
      }
    }
  }

  return false;
}

/**
 * Circularity score: how "round" is the route?
 *
 * Computes the ratio of the route's bounding box longest side vs shortest.
 * A perfect circle has ratio 1.0. We also check that the route's area
 * (via shoelace formula) is a reasonable fraction of the bounding box area.
 *
 * Returns a score from 0 (perfect circle) to higher = worse.
 * Score < 1.0 is considered "good enough" for a round loop.
 */
function circularityScore(geometry: GeoJSON.LineString): number {
  const coords = geometry.coordinates;
  if (coords.length < 10) return 0;

  // Bounding box
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  const widthM = haversineM(minLng, (minLat + maxLat) / 2, maxLng, (minLat + maxLat) / 2);
  const heightM = haversineM((minLng + maxLng) / 2, minLat, (minLng + maxLng) / 2, maxLat);

  if (widthM < 50 || heightM < 50) return 10; // Degenerate

  // Aspect ratio penalty: 1.0 = perfect square, higher = elongated
  const aspect = Math.max(widthM, heightM) / Math.min(widthM, heightM);

  // Shoelace area of the route polygon (in degree² — just for ratio)
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    area += coords[i][0] * coords[i + 1][1] - coords[i + 1][0] * coords[i][1];
  }
  area = Math.abs(area) / 2;

  // Bounding box area in degree²
  const bboxArea = (maxLng - minLng) * (maxLat - minLat);
  // Ideal circle fills ~π/4 ≈ 0.785 of its bounding square
  // We want area/bbox to be at least ~0.3 (generous for street routes)
  const fillRatio = bboxArea > 0 ? area / bboxArea : 0;
  const fillPenalty = fillRatio < 0.2 ? 3 : fillRatio < 0.3 ? 1 : 0;

  // Final score: aspect ratio - 1 (so perfect square = 0) + fill penalty
  return (aspect - 1) + fillPenalty;
}

function buildResult(
  distance: number,
  geometry: GeoJSON.LineString,
  waypoints: [number, number][],
  maneuvers: TurnManeuver[]
): RouteResult {
  const walkingDurationSeconds = Math.round((distance / 5000) * 3600);
  return {
    distance: Math.round(distance),
    duration: walkingDurationSeconds,
    geometry,
    waypoints,
    stepsEstimate: Math.round(distance / 0.75),
    maneuvers,
  };
}

/**
 * Main route generation function.
 * Generates a clean, roughly circular walking LOOP from a starting point.
 * Quality checks: distance range, no cul-de-sacs, no self-intersections, good circularity.
 * Tries up to MAX_ATTEMPTS times, returns the best valid route.
 */
export async function generateRoute(
  lat: number,
  lng: number,
  targetSteps: number = 10000
): Promise<RouteResult> {
  const targetDistanceM = targetSteps * 0.75;
  const minDistanceM = targetDistanceM * 0.9;
  const maxDistanceM = targetDistanceM * 1.1;
  const numWaypoints = Math.max(3, Math.min(8, Math.round(targetDistanceM / 1500)));
  let radiusKm = 1.2 * (targetDistanceM / 7500);
  let bestAny: CandidateRoute | null = null; // best route overall (fallback)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const waypoints = generateSafeWaypoints(lat, lng, radiusKm, numWaypoints);

    let result;
    try {
      result = await callOSRM([lat, lng], waypoints);
    } catch {
      continue;
    }

    // Skip routes through danger zones
    if (routePassesThroughDangerZone(result.geometry)) continue;

    const distanceOk =
      result.distance >= minDistanceM && result.distance <= maxDistanceM;
    const culDeSac = hasCulDeSac(result.geometry);
    const selfCross = hasSelfIntersection(result.geometry);
    const circScore = circularityScore(result.geometry);
    const shapeOk = !selfCross && circScore < 1.5;

    // Score: 0 = perfect, higher = worse
    const score =
      (distanceOk ? 0 : 1) +
      (culDeSac ? 5 : 0) +
      (selfCross ? 4 : 0) +
      circScore;

    // Perfect route found — return immediately
    if (distanceOk && !culDeSac && shapeOk) {
      return buildResult(result.distance, result.geometry, waypoints, result.maneuvers);
    }

    // Track best overall (for fallback)
    if (!bestAny || score < bestAny.score) {
      bestAny = {
        distance: result.distance,
        geometry: result.geometry,
        waypoints,
        maneuvers: result.maneuvers,
        score,
      };
    }

    // Adjust radius to converge toward target distance
    if (!distanceOk) {
      const ratio = targetDistanceM / result.distance;
      radiusKm = radiusKm * ratio;
      radiusKm = Math.max(0.3, Math.min(3.0, radiusKm));
    }
  }

  // Fallback: return best route found (may not be perfect)
  if (bestAny) {
    return buildResult(bestAny.distance, bestAny.geometry, bestAny.waypoints, bestAny.maneuvers);
  }

  // Ultimate fallback
  const waypoints = generateSafeWaypoints(lat, lng, radiusKm, numWaypoints);
  const result = await callOSRM([lat, lng], waypoints);
  return buildResult(result.distance, result.geometry, waypoints, result.maneuvers);
}
