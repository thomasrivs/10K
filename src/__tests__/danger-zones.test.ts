import { describe, it, expect } from "vitest";
import {
  isInDangerZone,
  filterSafeWaypoints,
  routePassesThroughDangerZone,
} from "@/lib/danger-zones";

describe("isInDangerZone", () => {
  it("returns true for a point inside Porte de la Chapelle zone", () => {
    // Center of the Porte de la Chapelle danger zone
    const lat = 48.895;
    const lng = 2.358;
    expect(isInDangerZone(lat, lng)).toBe(true);
  });

  it("returns false for a safe point (Tour Eiffel)", () => {
    const lat = 48.8584;
    const lng = 2.2945;
    expect(isInDangerZone(lat, lng)).toBe(false);
  });

  it("returns true for a point inside Stalingrad zone", () => {
    const lat = 48.882;
    const lng = 2.368;
    expect(isInDangerZone(lat, lng)).toBe(true);
  });

  it("returns false for a point far from Paris", () => {
    const lat = 45.764;
    const lng = 4.8357;
    expect(isInDangerZone(lat, lng)).toBe(false);
  });
});

describe("filterSafeWaypoints", () => {
  it("filters out waypoints in danger zones", () => {
    const waypoints: [number, number][] = [
      [48.895, 2.358],   // Porte de la Chapelle (danger)
      [48.8584, 2.2945], // Tour Eiffel (safe)
      [48.882, 2.368],   // Stalingrad (danger)
      [48.8606, 2.3376], // Saint-Germain (safe)
    ];

    const safe = filterSafeWaypoints(waypoints);
    expect(safe).toHaveLength(2);
    expect(safe[0]).toEqual([48.8584, 2.2945]);
    expect(safe[1]).toEqual([48.8606, 2.3376]);
  });

  it("returns all waypoints if none are in danger zones", () => {
    const waypoints: [number, number][] = [
      [48.8584, 2.2945], // Tour Eiffel
      [48.8606, 2.3376], // Saint-Germain
    ];

    const safe = filterSafeWaypoints(waypoints);
    expect(safe).toHaveLength(2);
  });

  it("returns empty array if all waypoints are dangerous", () => {
    const waypoints: [number, number][] = [
      [48.895, 2.358],  // Porte de la Chapelle
      [48.882, 2.368],  // Stalingrad
    ];

    const safe = filterSafeWaypoints(waypoints);
    expect(safe).toHaveLength(0);
  });
});

describe("routePassesThroughDangerZone", () => {
  it("detects a route passing through a danger zone", () => {
    // Route that goes through Porte de la Chapelle
    const geometry: GeoJSON.LineString = {
      type: "LineString",
      coordinates: [
        [2.34, 48.89],    // Start outside
        [2.355, 48.895],  // Enter danger zone
        [2.358, 48.895],  // Inside danger zone
        [2.362, 48.895],  // Still inside
        [2.37, 48.89],    // Exit
      ],
    };

    expect(routePassesThroughDangerZone(geometry)).toBe(true);
  });

  it("returns false for a safe route", () => {
    // Route near Tour Eiffel, far from danger zones
    const geometry: GeoJSON.LineString = {
      type: "LineString",
      coordinates: [
        [2.290, 48.855],
        [2.292, 48.857],
        [2.295, 48.860],
        [2.297, 48.862],
        [2.300, 48.865],
      ],
    };

    expect(routePassesThroughDangerZone(geometry)).toBe(false);
  });
});
