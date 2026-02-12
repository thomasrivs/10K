import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateRoute } from "@/lib/route-generator";

/**
 * Build a mock OSRM response with a given distance and a circular geometry.
 */
function buildOSRMResponse(distance: number, centerLat = 48.8566, centerLng = 2.3522) {
  const radius = 0.01 * (distance / 7500); // scale radius proportionally
  return {
    code: "Ok",
    routes: [
      {
        distance,
        duration: Math.round((distance / 5000) * 3600),
        geometry: {
          type: "LineString" as const,
          coordinates: Array.from({ length: 100 }, (_, i) => {
            const angle = (i / 100) * 2 * Math.PI;
            return [
              centerLng + radius * Math.cos(angle),
              centerLat + radius * Math.sin(angle),
            ];
          }),
        },
        legs: [],
      },
    ],
  };
}

/**
 * Haversine distance between two [lng, lat] pairs (meters).
 */
function haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number {
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
 * Smart OSRM mock that responds proportionally to waypoint spread.
 * Parses the OSRM URL to extract waypoints, computes the max distance
 * from start to any waypoint (≈ loop radius), and returns a route
 * distance ≈ 2π × radius (circumference of the loop).
 */
function createSmartOSRMMock() {
  return vi.fn().mockImplementation((url: string) => {
    const match = url.match(/\/foot\/([^?]+)/);
    if (!match) {
      return Promise.reject(new Error("Bad URL"));
    }

    const points = match[1].split(";").map((p) => {
      const [lng, lat] = p.split(",").map(Number);
      return [lng, lat];
    });

    // Compute max distance from start to any waypoint (≈ loop radius)
    const startLng = points[0][0], startLat = points[0][1];
    let maxRadius = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = haversineM(startLng, startLat, points[i][0], points[i][1]);
      if (d > maxRadius) maxRadius = d;
    }

    // Walking loop distance ≈ circumference = 2π × radius
    const routeDistance = maxRadius * 2 * Math.PI;

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(buildOSRMResponse(routeDistance, startLat, startLng)),
    });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("generateRoute", () => {
  it("returns a route with required fields", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(buildOSRMResponse(7500)),
    });

    const result = await generateRoute(48.8566, 2.3522);

    expect(result).toHaveProperty("distance");
    expect(result).toHaveProperty("duration");
    expect(result).toHaveProperty("geometry");
    expect(result).toHaveProperty("stepsEstimate");
    expect(result).toHaveProperty("waypoints");
  });

  it("returns numeric distance and stepsEstimate", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(buildOSRMResponse(7500)),
    });

    const result = await generateRoute(48.8566, 2.3522);

    expect(typeof result.distance).toBe("number");
    expect(typeof result.stepsEstimate).toBe("number");
    expect(typeof result.duration).toBe("number");
    expect(result.distance).toBeGreaterThan(0);
    expect(result.stepsEstimate).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThan(0);
  });

  it("returns a valid GeoJSON LineString geometry", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(buildOSRMResponse(7500)),
    });

    const result = await generateRoute(48.8566, 2.3522);

    expect(result.geometry.type).toBe("LineString");
    expect(Array.isArray(result.geometry.coordinates)).toBe(true);
    expect(result.geometry.coordinates.length).toBeGreaterThan(0);
  });

  it("stepsEstimate is approximately distance / 0.75", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(buildOSRMResponse(7500)),
    });

    const result = await generateRoute(48.8566, 2.3522);

    const expectedSteps = Math.round(result.distance / 0.75);
    expect(result.stepsEstimate).toBe(expectedSteps);
  });

  it("retries when OSRM call fails", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.reject(new Error("Network error"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(buildOSRMResponse(7500)),
      });
    });

    const result = await generateRoute(48.8566, 2.3522);

    expect(result).toHaveProperty("distance");
    expect(callCount).toBeGreaterThan(2);
  });
});

describe("step count accuracy (±500 steps)", () => {
  const testCases = [
    { targetSteps: 3000, label: "3K steps" },
    { targetSteps: 6000, label: "6K steps" },
    { targetSteps: 10000, label: "10K steps" },
    { targetSteps: 15000, label: "15K steps" },
  ];

  // Happy path: OSRM returns exact target distance
  for (const { targetSteps, label } of testCases) {
    it(`${label}: OSRM returns exact target distance → within ±500`, async () => {
      const targetDistance = targetSteps * 0.75;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(buildOSRMResponse(targetDistance)),
      });

      const result = await generateRoute(48.8566, 2.3522, targetSteps);

      expect(result.stepsEstimate).toBeGreaterThanOrEqual(targetSteps - 500);
      expect(result.stepsEstimate).toBeLessThanOrEqual(targetSteps + 500);
    });
  }

  // Slight deviation within ±375m: should still be accepted
  for (const { targetSteps, label } of testCases) {
    it(`${label}: OSRM returns +300m deviation → within ±500`, async () => {
      const targetDistance = targetSteps * 0.75;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(buildOSRMResponse(targetDistance + 300)),
      });

      const result = await generateRoute(48.8566, 2.3522, targetSteps);

      expect(result.stepsEstimate).toBeGreaterThanOrEqual(targetSteps - 500);
      expect(result.stepsEstimate).toBeLessThanOrEqual(targetSteps + 500);
    });
  }

  // Smart mock: OSRM responds proportionally to waypoint spread → convergence works
  for (const { targetSteps, label } of testCases) {
    it(`${label}: smart OSRM mock (proportional distances) → within ±500`, async () => {
      global.fetch = createSmartOSRMMock();
      // Stabilize waypoint jitter for deterministic convergence
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      const result = await generateRoute(48.8566, 2.3522, targetSteps);

      expect(result.stepsEstimate).toBeGreaterThanOrEqual(targetSteps - 500);
      expect(result.stepsEstimate).toBeLessThanOrEqual(targetSteps + 500);
    });
  }

  // OSRM always returns wildly wrong distance → should throw error (not return garbage)
  for (const { targetSteps, label } of testCases) {
    it(`${label}: OSRM always returns 5× target → throws error`, async () => {
      const targetDistance = targetSteps * 0.75;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(buildOSRMResponse(targetDistance * 5)),
      });

      await expect(
        generateRoute(48.8566, 2.3522, targetSteps)
      ).rejects.toThrow("Impossible de générer un parcours");
    });
  }
});
