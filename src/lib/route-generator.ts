import { isInDangerZone, routePassesThroughDangerZone } from "./danger-zones";

const OSRM_BASE_URL = "https://router.project-osrm.org";
const TARGET_DISTANCE_M = 7500; // ~10,000 steps at 0.75m/step
const MIN_DISTANCE_M = 6500; // Accept slightly shorter to avoid cul-de-sacs
const MAX_DISTANCE_M = 8500;
const NUM_WAYPOINTS = 6;
const MAX_WAYPOINT_RETRIES = 3;

// Strict thresholds
const MAX_OVERLAP_RATIO = 0.03; // Max 3% large-scale overlap
const MAX_CUL_DE_SAC_RATIO = 0.01; // Max 1% cul-de-sac (essentially zero tolerance)
const MAX_ATTEMPTS = 16;

interface RouteResult {
  distance: number; // meters
  duration: number; // seconds
  geometry: GeoJSON.LineString;
  waypoints: [number, number][];
  stepsEstimate: number;
}

interface CandidateRoute {
  distance: number;
  geometry: GeoJSON.LineString;
  waypoints: [number, number][];
  score: number; // Combined quality score (lower = better)
}

/**
 * Generate a single waypoint at a given angle and radius from center.
 */
function generateSingleWaypoint(
  centerLat: number,
  centerLng: number,
  radiusKm: number,
  angle: number
): [number, number] {
  const latDegPerKm = 1 / 111.32;
  const lngDegPerKm = 1 / (111.32 * Math.cos((centerLat * Math.PI) / 180));

  const r = radiusKm * (0.9 + Math.random() * 0.2);
  const jitter = (Math.random() - 0.5) * 0.1;

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
async function callOSRM(
  start: [number, number],
  waypoints: [number, number][]
): Promise<{
  distance: number;
  duration: number;
  geometry: GeoJSON.LineString;
}> {
  const allPoints = [start, ...waypoints, start];
  const coordString = allPoints
    .map(([lat, lng]) => `${lng},${lat}`)
    .join(";");

  const url = `${OSRM_BASE_URL}/route/v1/foot/${coordString}?overview=full&geometries=geojson&continue_straight=true`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM API error: ${response.status}`);
  }

  const data = await response.json();

  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
    throw new Error(`OSRM returned no route: ${data.code}`);
  }

  const route = data.routes[0];
  return {
    distance: route.distance,
    duration: route.duration,
    geometry: route.geometry,
  };
}

/**
 * Large-scale backtracking detection.
 * Catches when the same street is used at two distant parts of the route.
 * Uses MIN_SEQ_GAP = 10% to only flag far-apart revisits.
 */
function computeOverlapRatio(geometry: GeoJSON.LineString): number {
  const coords = geometry.coordinates;
  if (coords.length < 10) return 0;

  const CELL_SIZE = 0.00015; // ~15m grid
  const cellFirstSeen = new Map<string, number>();
  let overlapping = 0;
  const total = coords.length;
  const MIN_SEQ_GAP = Math.floor(total * 0.10);

  for (let i = 0; i < total; i++) {
    const cellX = Math.floor(coords[i][0] / CELL_SIZE);
    const cellY = Math.floor(coords[i][1] / CELL_SIZE);
    const key = `${cellX},${cellY}`;

    const firstIdx = cellFirstSeen.get(key);
    if (firstIdx !== undefined) {
      if (i - firstIdx > MIN_SEQ_GAP) {
        overlapping++;
      }
    } else {
      cellFirstSeen.set(key, i);
    }
  }

  return overlapping / total;
}

/**
 * Cul-de-sac detection.
 * A cul-de-sac is when the route goes to a location and comes back on
 * (roughly) the same path shortly after. This creates an out-and-back
 * pattern where nearby cells are visited twice with a small sequence gap.
 *
 * Strategy: for each cell visited, store ALL visit indices. Then check
 * for pairs of visits that are close in sequence (20-500 points apart)
 * but far enough to not be immediate neighbors.
 * Excludes the first/last 8% of the route (natural loop closure zone).
 */
function computeCulDeSacRatio(geometry: GeoJSON.LineString): number {
  const coords = geometry.coordinates;
  if (coords.length < 40) return 0;

  const CELL_SIZE = 0.00012; // ~13m grid (tighter than overlap detector)
  const total = coords.length;

  // Sequence gap bounds for cul-de-sac detection:
  // - Min 20 points apart (skip immediate neighbors on the same street segment)
  // - Max 20% of route (beyond that it's large-scale backtracking, not a cul-de-sac)
  const MIN_GAP = 20;
  const MAX_GAP = Math.floor(total * 0.20);

  // Exclude natural loop closure zone (first/last 8%)
  const ZONE_START = Math.floor(total * 0.08);
  const ZONE_END = total - Math.floor(total * 0.08);

  // Collect all visit indices per cell
  const cellVisits = new Map<string, number[]>();

  for (let i = 0; i < total; i++) {
    const cellX = Math.floor(coords[i][0] / CELL_SIZE);
    const cellY = Math.floor(coords[i][1] / CELL_SIZE);
    const key = `${cellX},${cellY}`;

    let visits = cellVisits.get(key);
    if (!visits) {
      visits = [];
      cellVisits.set(key, visits);
    }
    visits.push(i);
  }

  // Count cells that show cul-de-sac pattern
  let culDeSacPoints = 0;

  for (const visits of cellVisits.values()) {
    if (visits.length < 2) continue;

    let isCulDeSac = false;
    for (let a = 0; a < visits.length - 1 && !isCulDeSac; a++) {
      for (let b = a + 1; b < visits.length; b++) {
        const gap = visits[b] - visits[a];
        if (gap < MIN_GAP) continue; // Too close in sequence, normal
        if (gap > MAX_GAP) break; // Too far apart, not a cul-de-sac

        // Both visits must be in the middle zone (not loop closure)
        if (visits[a] >= ZONE_START && visits[b] <= ZONE_END) {
          isCulDeSac = true;
          break;
        }
      }
    }

    if (isCulDeSac) {
      // Count all points in this cell as cul-de-sac points
      culDeSacPoints += visits.length;
    }
  }

  return culDeSacPoints / total;
}

/**
 * Combined route quality score. Lower is better.
 * Cul-de-sacs are weighted 3x more than large-scale overlap because
 * they are more noticeable and annoying to the walker.
 */
function routeQualityScore(geometry: GeoJSON.LineString): {
  overlap: number;
  culDeSac: number;
  score: number;
} {
  const overlap = computeOverlapRatio(geometry);
  const culDeSac = computeCulDeSacRatio(geometry);
  const score = overlap + culDeSac * 3;
  return { overlap, culDeSac, score };
}

function buildResult(
  distance: number,
  geometry: GeoJSON.LineString,
  waypoints: [number, number][]
): RouteResult {
  const walkingDurationSeconds = Math.round((distance / 5000) * 3600);
  return {
    distance: Math.round(distance),
    duration: walkingDurationSeconds,
    geometry,
    waypoints,
    stepsEstimate: Math.round(distance / 0.75),
  };
}

/**
 * Main route generation function.
 * Generates a clean walking LOOP of ~7.5km from a starting point.
 * Strictly rejects any route with backtracking or cul-de-sacs.
 * Tries up to MAX_ATTEMPTS times, always returns the cleanest route found.
 */
export async function generateRoute(
  lat: number,
  lng: number
): Promise<RouteResult> {
  let radiusKm = 1.2;
  let best: CandidateRoute | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const waypoints = generateSafeWaypoints(lat, lng, radiusKm, NUM_WAYPOINTS);

    let result;
    try {
      result = await callOSRM([lat, lng], waypoints);
    } catch {
      continue;
    }

    // Skip routes through danger zones
    if (routePassesThroughDangerZone(result.geometry)) continue;

    const { overlap, culDeSac, score } = routeQualityScore(result.geometry);
    const distanceOk =
      result.distance >= MIN_DISTANCE_M && result.distance <= MAX_DISTANCE_M;

    // Track best route found so far
    if (!best || score < best.score) {
      best = {
        distance: result.distance,
        geometry: result.geometry,
        waypoints,
        score,
      };
    }

    // Perfect: clean loop + no cul-de-sacs + good distance → return
    if (
      distanceOk &&
      overlap <= MAX_OVERLAP_RATIO &&
      culDeSac <= MAX_CUL_DE_SAC_RATIO
    ) {
      return buildResult(result.distance, result.geometry, waypoints);
    }

    // Adjust radius if distance is wrong
    if (!distanceOk) {
      const ratio = TARGET_DISTANCE_M / result.distance;
      radiusKm = radiusKm * ratio;
      radiusKm = Math.max(0.3, Math.min(3.0, radiusKm));
    }

    // Overlap or cul-de-sac too high → retry with new random waypoints
  }

  // Return the cleanest route found across all attempts
  if (best) {
    return buildResult(best.distance, best.geometry, best.waypoints);
  }

  // Ultimate fallback
  const waypoints = generateSafeWaypoints(lat, lng, radiusKm, NUM_WAYPOINTS);
  const result = await callOSRM([lat, lng], waypoints);
  return buildResult(result.distance, result.geometry, waypoints);
}
