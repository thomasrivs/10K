import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateRoute } from "@/lib/route-generator";

// Mock OSRM API
const mockOSRMResponse = {
  code: "Ok",
  routes: [
    {
      distance: 7500,
      duration: 5400,
      geometry: {
        type: "LineString" as const,
        coordinates: Array.from({ length: 100 }, (_, i) => {
          const angle = (i / 100) * 2 * Math.PI;
          const radius = 0.01;
          return [
            2.3522 + radius * Math.cos(angle),
            48.8566 + radius * Math.sin(angle),
          ];
        }),
      },
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("generateRoute", () => {
  it("returns a route with required fields", async () => {
    // Mock global fetch for OSRM calls
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockOSRMResponse),
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
      json: () => Promise.resolve(mockOSRMResponse),
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
      json: () => Promise.resolve(mockOSRMResponse),
    });

    const result = await generateRoute(48.8566, 2.3522);

    expect(result.geometry.type).toBe("LineString");
    expect(Array.isArray(result.geometry.coordinates)).toBe(true);
    expect(result.geometry.coordinates.length).toBeGreaterThan(0);
  });

  it("stepsEstimate is approximately distance / 0.75", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockOSRMResponse),
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
        json: () => Promise.resolve(mockOSRMResponse),
      });
    });

    const result = await generateRoute(48.8566, 2.3522);

    expect(result).toHaveProperty("distance");
    expect(callCount).toBeGreaterThan(2);
  });
});
