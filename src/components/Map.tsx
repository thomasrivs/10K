"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  CircleMarker,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";

// ─── Constants ───────────────────────────────────────────────

const DEFAULT_CENTER: [number, number] = [48.8566, 2.3522];
const DEFAULT_ZOOM = 14;
const ARRIVAL_DISTANCE_M = 50;
const ARRIVAL_PROGRESS_RATIO = 0.8;

// ─── Types ───────────────────────────────────────────────────

type AppMode =
  | "idle"
  | "locating"
  | "positioned"
  | "generating"
  | "route_shown"
  | "tracking"
  | "paused";

interface RouteData {
  id: string | null;
  distance_m: number;
  duration_s: number;
  steps_estimate: number;
  geometry: GeoJSON.LineString;
  routes_used: number;
  routes_limit: number;
}

interface HistoryRoute {
  id: string;
  start_lat: number;
  start_lng: number;
  distance_m: number;
  steps_estimate: number;
  duration_s: number | null;
  geometry: GeoJSON.LineString | null;
  status: string;
  walked_distance_m: number | null;
  walked_duration_s: number | null;
  completed_at: string | null;
  created_at: string;
}

// ─── Icons ───────────────────────────────────────────────────

const startIcon = new L.DivIcon({
  html: `<div style="position:relative;width:22px;height:22px">
    <div style="position:absolute;inset:0;background:#00f5d4;border-radius:50%;opacity:0.3;animation:pulse-ring 1.5s cubic-bezier(0.215,0.61,0.355,1) infinite"></div>
    <div style="position:absolute;inset:3px;background:#00f5d4;border-radius:50%;border:3px solid #1a1a2e;box-shadow:0 0 12px rgba(0,245,212,0.5)"></div>
  </div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  className: "",
});

const liveIcon = new L.DivIcon({
  html: `<div style="position:relative;width:28px;height:28px">
    <div style="position:absolute;inset:0;background:#00f5d4;border-radius:50%;opacity:0.25;animation:pulse-ring 1.5s cubic-bezier(0.215,0.61,0.355,1) infinite"></div>
    <div style="position:absolute;inset:4px;background:#00f5d4;border-radius:50%;border:3px solid #1a1a2e;box-shadow:0 0 16px rgba(0,245,212,0.6)"></div>
  </div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  className: "",
});

// ─── Map helpers ─────────────────────────────────────────────

function FlyToPosition({ position }: { position: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo(position, 15);
  }, [map, position]);
  return null;
}

function FollowUser({ position }: { position: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(position, map.getZoom(), { animate: true });
  }, [map, position]);
  return null;
}

function FitRouteBounds({ geometry }: { geometry: GeoJSON.LineString }) {
  const map = useMap();
  useEffect(() => {
    const coords = geometry.coordinates.map(
      (c) => [c[1], c[0]] as [number, number]
    );
    if (coords.length > 0) {
      const bounds = L.latLngBounds(coords);
      map.fitBounds(bounds, { padding: [60, 60] });
    }
  }, [map, geometry]);
  return null;
}

// ─── Gradient route (cyan → red for dark theme) ─────────────

function GradientRoute({ geometry }: { geometry: GeoJSON.LineString }) {
  const coords = geometry.coordinates;
  if (coords.length < 2) return null;

  const numSegments = 40;
  const segmentSize = Math.max(2, Math.floor(coords.length / numSegments));
  const segments: { positions: [number, number][]; color: string }[] = [];

  for (let i = 0; i < coords.length - 1; i += segmentSize) {
    const end = Math.min(i + segmentSize + 1, coords.length);
    const segCoords = coords
      .slice(i, end)
      .map((c) => [c[1], c[0]] as [number, number]);
    const t = i / Math.max(1, coords.length - 1);
    // Cyan (hue 170) → Red (0) - vibrant on dark background
    const hue = 170 * (1 - t);
    const sat = 90;
    const light = 55;
    segments.push({
      positions: segCoords,
      color: `hsl(${hue}, ${sat}%, ${light}%)`,
    });
  }

  return (
    <>
      {segments.map((seg, idx) => (
        <Polyline
          key={idx}
          positions={seg.positions}
          pathOptions={{ color: seg.color, weight: 5, opacity: 0.95 }}
        />
      ))}
    </>
  );
}

// ─── Direction arrows ────────────────────────────────────────

function bearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function RouteArrows({ geometry }: { geometry: GeoJSON.LineString }) {
  const coords = geometry.coordinates;
  if (coords.length < 4) return null;

  const arrowCount = 12;
  const step = Math.max(1, Math.floor(coords.length / arrowCount));
  const arrows: {
    position: [number, number];
    angle: number;
    color: string;
  }[] = [];

  for (let i = step; i < coords.length - 1; i += step) {
    const prev = coords[i];
    const next = coords[Math.min(i + 1, coords.length - 1)];
    const angle = bearing(prev[1], prev[0], next[1], next[0]);
    const t = i / (coords.length - 1);
    const hue = 170 * (1 - t);
    arrows.push({
      position: [prev[1], prev[0]],
      angle,
      color: `hsl(${hue}, 90%, 45%)`,
    });
  }

  return (
    <>
      {arrows.map((a, idx) => (
        <Marker
          key={idx}
          position={a.position}
          interactive={false}
          icon={
            new L.DivIcon({
              html: `<svg width="22" height="22" viewBox="0 0 22 22" style="transform:rotate(${a.angle}deg);filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6))"><polygon points="11,2 20,18 11,13 2,18" fill="${a.color}" stroke="#1a1a2e" stroke-width="1.5"/></svg>`,
              iconSize: [22, 22],
              iconAnchor: [11, 11],
              className: "",
            })
          }
        />
      ))}
    </>
  );
}

// ─── Utilities ───────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}`;
  return `${minutes} min`;
}

function formatTrackingTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function distanceBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    generated: { label: "Généré", cls: "bg-dark-border text-text-secondary" },
    in_progress: { label: "En cours", cls: "bg-accent-cyan/20 text-accent-cyan" },
    completed: { label: "Terminé", cls: "bg-accent-green/20 text-accent-green" },
    abandoned: { label: "Abandonné", cls: "bg-accent-red/20 text-accent-red" },
  };
  const s = map[status] ?? map.generated;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${s.cls}`}>
      {s.label}
    </span>
  );
}

// ─── Main Component ──────────────────────────────────────────

export default function Map() {
  const [appMode, setAppMode] = useState<AppMode>("idle");
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [livePosition, setLivePosition] = useState<[number, number] | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [routeData, setRouteData] = useState<RouteData | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  // Tracking state
  const [walkedDistance, setWalkedDistance] = useState(0);
  const [trackingTime, setTrackingTime] = useState(0);
  const [gpsLost, setGpsLost] = useState(false);
  const [showCongrats, setShowCongrats] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  const lastPosRef = useRef<[number, number] | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // History state
  const [showHistory, setShowHistory] = useState(false);
  const [historyRoutes, setHistoryRoutes] = useState<HistoryRoute[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewingHistory, setViewingHistory] = useState<HistoryRoute | null>(null);

  const supabase = createClient();
  const router = useRouter();

  // ─── Cleanup on unmount ─────────────────────────────────
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ─── Tracking timer ─────────────────────────────────────
  useEffect(() => {
    if (appMode === "tracking") {
      timerRef.current = setInterval(() => {
        setTrackingTime((t) => t + 1);
      }, 1000);
    } else if (appMode !== "paused") {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    // Pause: just stop the interval, keep the time
    if (appMode === "paused" && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [appMode]);

  // ─── Auth ───────────────────────────────────────────────
  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  // ─── Geolocation ────────────────────────────────────────
  const requestLocation = () => {
    if (!navigator.geolocation) {
      setGeoError("La géolocalisation n'est pas supportée par votre navigateur.");
      return;
    }
    setAppMode("locating");
    setGeoError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserPosition([pos.coords.latitude, pos.coords.longitude]);
        setAppMode("positioned");
      },
      (err) => {
        setAppMode("idle");
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setGeoError("Accès à la position refusé. Autorisez la géolocalisation.");
            break;
          case err.POSITION_UNAVAILABLE:
            setGeoError("Position indisponible.");
            break;
          case err.TIMEOUT:
            setGeoError("Délai dépassé. Réessayez.");
            break;
          default:
            setGeoError("Erreur de géolocalisation.");
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  };

  // ─── Route generation ──────────────────────────────────
  const generateRoute = async () => {
    if (!userPosition) return;
    setAppMode("generating");
    setRouteError(null);
    setRouteData(null);
    setLimitReached(false);
    setViewingHistory(null);

    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: userPosition[0], lng: userPosition[1] }),
      });

      const data = await res.json();

      if (res.status === 403 && data.error === "limit_reached") {
        setLimitReached(true);
        setAppMode("positioned");
        return;
      }

      if (!res.ok) throw new Error(data.error || "Erreur serveur");

      setRouteData(data as RouteData);
      setAppMode("route_shown");
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : "Erreur lors de la génération");
      setAppMode("positioned");
    }
  };

  // ─── GPS Tracking ──────────────────────────────────────
  const checkArrival = useCallback(
    (pos: [number, number]) => {
      if (!userPosition || !routeData) return;
      const distToStart = distanceBetween(pos[0], pos[1], userPosition[0], userPosition[1]);
      if (distToStart < ARRIVAL_DISTANCE_M && walkedDistance > routeData.distance_m * ARRIVAL_PROGRESS_RATIO) {
        stopTracking("completed");
        setShowCongrats(true);
      }
    },
    [userPosition, routeData, walkedDistance]
  );

  const startTracking = useCallback(() => {
    if (!routeData || !userPosition) return;
    setAppMode("tracking");
    setWalkedDistance(0);
    setTrackingTime(0);
    setGpsLost(false);
    lastPosRef.current = userPosition;
    setLivePosition(userPosition);

    // Update route status to in_progress
    if (routeData.id) {
      fetch(`/api/route/${routeData.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      }).catch(() => {});
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const newPos: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setGpsLost(false);
        setLivePosition(newPos);
        if (lastPosRef.current) {
          const d = distanceBetween(lastPosRef.current[0], lastPosRef.current[1], newPos[0], newPos[1]);
          if (d > 3 && d < 100) {
            setWalkedDistance((prev) => prev + d);
          }
        }
        lastPosRef.current = newPos;
        checkArrival(newPos);
      },
      () => setGpsLost(true),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  }, [routeData, userPosition, checkArrival]);

  const pauseTracking = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setAppMode("paused");
  };

  const resumeTracking = () => {
    setAppMode("tracking");
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const newPos: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setGpsLost(false);
        setLivePosition(newPos);
        if (lastPosRef.current) {
          const d = distanceBetween(lastPosRef.current[0], lastPosRef.current[1], newPos[0], newPos[1]);
          if (d > 3 && d < 100) {
            setWalkedDistance((prev) => prev + d);
          }
        }
        lastPosRef.current = newPos;
        checkArrival(newPos);
      },
      () => setGpsLost(true),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  };

  const stopTracking = useCallback(
    (status: "completed" | "abandoned") => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      // Save to DB
      if (routeData?.id) {
        fetch(`/api/route/${routeData.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            walked_distance_m: walkedDistance,
            walked_duration_s: trackingTime,
          }),
        }).catch(() => {});
      }

      setAppMode("route_shown");
    },
    [routeData, walkedDistance, trackingTime]
  );

  // ─── History ────────────────────────────────────────────
  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      if (res.ok) setHistoryRoutes(data.routes ?? []);
    } catch {
      // silent
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleHistory = () => {
    if (!showHistory) loadHistory();
    setShowHistory(!showHistory);
  };

  const viewHistoryRoute = (route: HistoryRoute) => {
    setViewingHistory(route);
    setShowHistory(false);
    if (route.geometry) {
      setRouteData({
        id: route.id,
        distance_m: route.distance_m,
        duration_s: route.duration_s ?? 0,
        steps_estimate: route.steps_estimate,
        geometry: route.geometry,
        routes_used: 0,
        routes_limit: 0,
      });
      setUserPosition([route.start_lat, route.start_lng]);
      setAppMode("route_shown");
    }
  };

  const redoRoute = (route: HistoryRoute) => {
    setShowHistory(false);
    setViewingHistory(null);
    setUserPosition([route.start_lat, route.start_lng]);
    setAppMode("positioned");
    setTimeout(() => generateRoute(), 100);
  };

  // ─── Main action handler ───────────────────────────────
  const handleMainAction = () => {
    if (appMode === "idle") {
      requestLocation();
    } else if (appMode === "positioned") {
      generateRoute();
    } else if (appMode === "route_shown" && !viewingHistory) {
      generateRoute();
    } else if (appMode === "route_shown" && viewingHistory) {
      setViewingHistory(null);
      setRouteData(null);
      setUserPosition(null);
      setAppMode("idle");
    }
  };

  // ─── Computed values ───────────────────────────────────
  const isTracking = appMode === "tracking" || appMode === "paused";
  const remainingDistance = routeData ? Math.max(0, routeData.distance_m - walkedDistance) : 0;
  const activeGeometry = routeData?.geometry ?? viewingHistory?.geometry ?? null;

  return (
    <div className="relative h-full w-full">
      {/* ─── Map ─────────────────────────────────────── */}
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        zoomControl={false}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        {/* Fly to user position (not during tracking) */}
        {userPosition && !routeData && !isTracking && (
          <FlyToPosition position={userPosition} />
        )}

        {/* Follow user during tracking */}
        {isTracking && livePosition && <FollowUser position={livePosition} />}

        {/* User position circle (before route) */}
        {userPosition && !routeData && !isTracking && (
          <CircleMarker
            center={userPosition}
            radius={10}
            pathOptions={{
              color: "#00f5d4",
              fillColor: "#00f5d4",
              fillOpacity: 0.7,
              weight: 3,
            }}
          >
            <Popup>Vous êtes ici</Popup>
          </CircleMarker>
        )}

        {/* Start marker (with route) */}
        {userPosition && routeData && !isTracking && (
          <Marker position={userPosition} icon={startIcon}>
            <Popup>Départ / Arrivée</Popup>
          </Marker>
        )}

        {/* Live tracking marker */}
        {isTracking && livePosition && (
          <Marker position={livePosition} icon={liveIcon} />
        )}

        {/* Route display */}
        {activeGeometry && (
          <>
            <GradientRoute geometry={activeGeometry} />
            <RouteArrows geometry={activeGeometry} />
            {!isTracking && <FitRouteBounds geometry={activeGeometry} />}
          </>
        )}
      </MapContainer>

      {/* ─── Route info panel ────────────────────────── */}
      {routeData && !isTracking && (
        <div className="glass-card animate-fade-in-up absolute top-[calc(env(safe-area-inset-top,0px)+1rem)] left-1/2 z-[1000] w-[90%] max-w-sm -translate-x-1/2 px-4 py-3">
          <div className="flex items-center justify-center gap-3 font-[family-name:var(--font-montserrat)] text-sm font-semibold">
            <div className="flex flex-col items-center">
              <span className="text-lg text-accent-cyan">
                {(routeData.distance_m / 1000).toFixed(1)}
              </span>
              <span className="text-[10px] font-normal text-text-muted">km</span>
            </div>
            <div className="h-8 w-px bg-dark-border" />
            <div className="flex flex-col items-center">
              <span className="text-lg text-accent-cyan">
                {routeData.steps_estimate.toLocaleString()}
              </span>
              <span className="text-[10px] font-normal text-text-muted">pas</span>
            </div>
            <div className="h-8 w-px bg-dark-border" />
            <div className="flex flex-col items-center">
              <span className="text-lg text-accent-cyan">
                {formatDuration(routeData.duration_s)}
              </span>
              <span className="text-[10px] font-normal text-text-muted">durée</span>
            </div>
          </div>
          {routeData.routes_limit > 0 && (
            <p className="mt-2 text-center text-[10px] text-text-muted">
              {routeData.routes_used}/{routeData.routes_limit} parcours gratuits utilisés
            </p>
          )}
        </div>
      )}

      {/* ─── Tracking stats bar ──────────────────────── */}
      {isTracking && (
        <div className="glass-card animate-fade-in-up safe-bottom absolute bottom-0 left-0 right-0 z-[1000] px-4 pb-6 pt-4">
          {gpsLost && (
            <div className="toast-error mb-3 rounded-lg px-3 py-1.5 text-center text-xs">
              Signal GPS perdu...
            </div>
          )}
          <div className="mb-4 flex items-center justify-around font-[family-name:var(--font-montserrat)] text-sm">
            <div className="flex flex-col items-center">
              <span className="text-xl font-bold text-accent-cyan">
                {(walkedDistance / 1000).toFixed(2)}
              </span>
              <span className="text-[10px] text-text-muted">km parcourus</span>
            </div>
            <div className="h-10 w-px bg-dark-border" />
            <div className="flex flex-col items-center">
              <span className="text-xl font-bold text-accent-cyan">
                {formatTrackingTime(trackingTime)}
              </span>
              <span className="text-[10px] text-text-muted">temps</span>
            </div>
            <div className="h-10 w-px bg-dark-border" />
            <div className="flex flex-col items-center">
              <span className="text-xl font-bold text-accent-cyan">
                {(remainingDistance / 1000).toFixed(2)}
              </span>
              <span className="text-[10px] text-text-muted">km restants</span>
            </div>
          </div>
          <div className="flex gap-3">
            {appMode === "tracking" ? (
              <button
                onClick={pauseTracking}
                className="flex-1 rounded-xl bg-dark-border py-3 text-sm font-bold text-text-primary transition-all active:scale-95"
              >
                Pause
              </button>
            ) : (
              <button
                onClick={resumeTracking}
                className="btn-gradient flex-1 rounded-xl py-3 text-sm"
              >
                Reprendre
              </button>
            )}
            <button
              onClick={() => stopTracking("abandoned")}
              className="flex-1 rounded-xl bg-accent-red/20 py-3 text-sm font-bold text-accent-red transition-all active:scale-95"
            >
              Arrêter
            </button>
          </div>
        </div>
      )}

      {/* ─── Congrats modal ──────────────────────────── */}
      {showCongrats && (
        <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60">
          <div className="glass-card animate-scale-in mx-4 max-w-sm p-6 text-center">
            <div className="mb-3 text-5xl">&#127942;</div>
            <h2 className="font-[family-name:var(--font-montserrat)] text-xl font-bold text-accent-cyan">
              Parcours terminé !
            </h2>
            <div className="mt-4 flex justify-around">
              <div className="flex flex-col items-center">
                <span className="font-[family-name:var(--font-montserrat)] text-lg font-bold text-text-primary">
                  {(walkedDistance / 1000).toFixed(2)} km
                </span>
                <span className="text-xs text-text-muted">distance</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="font-[family-name:var(--font-montserrat)] text-lg font-bold text-text-primary">
                  {formatTrackingTime(trackingTime)}
                </span>
                <span className="text-xs text-text-muted">temps</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="font-[family-name:var(--font-montserrat)] text-lg font-bold text-text-primary">
                  {Math.round(walkedDistance / 0.75).toLocaleString()}
                </span>
                <span className="text-xs text-text-muted">pas</span>
              </div>
            </div>
            <button
              onClick={() => setShowCongrats(false)}
              className="btn-gradient mt-6 w-full rounded-xl py-3 text-sm"
            >
              Continuer
            </button>
          </div>
        </div>
      )}

      {/* ─── Paywall ─────────────────────────────────── */}
      {limitReached && (
        <div className="absolute inset-0 z-[2000] flex items-center justify-center bg-black/60">
          <div className="glass-card animate-scale-in mx-4 max-w-sm p-6 text-center">
            <h2 className="font-[family-name:var(--font-montserrat)] text-xl font-bold text-text-primary">
              Limite atteinte
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              Vous avez utilisé vos 5 parcours gratuits. Passez à la version
              premium pour des parcours illimités.
            </p>
            <button className="btn-gradient-orange mt-4 w-full rounded-xl py-3 text-sm">
              Passer en Premium
            </button>
            <button
              onClick={() => setLimitReached(false)}
              className="mt-2 w-full rounded-lg py-2 text-sm text-text-muted transition-colors hover:text-text-secondary"
            >
              Fermer
            </button>
          </div>
        </div>
      )}

      {/* ─── Bottom action bar ────────────────────────── */}
      {!limitReached && !isTracking && !showCongrats && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-[1000] bg-gradient-to-t from-dark-base via-dark-base/60 to-transparent px-4 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] pt-12">
          <div className="pointer-events-auto flex gap-3">
            {appMode === "route_shown" && !viewingHistory && (
              <button
                onClick={startTracking}
                className="animate-fade-in-up btn-gradient flex flex-1 items-center justify-center gap-2 rounded-xl py-3.5 text-base active:scale-[0.98]"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Démarrer
              </button>
            )}
            <button
              onClick={handleMainAction}
              disabled={appMode === "locating" || appMode === "generating"}
              className={`animate-fade-in-up flex items-center justify-center gap-2 rounded-xl py-3.5 text-base font-bold transition-all active:scale-[0.98] disabled:opacity-50 ${
                appMode === "route_shown" && !viewingHistory
                  ? "border border-dark-border bg-dark-card px-5 text-text-secondary"
                  : "btn-gradient flex-1"
              }`}
            >
              {(appMode === "locating" || appMode === "generating") && (
                <span className="spinner-sm" />
              )}
              {appMode === "idle"
                ? "Me localiser"
                : appMode === "locating"
                  ? "Localisation..."
                  : appMode === "generating"
                    ? "Génération..."
                    : appMode === "positioned"
                      ? "Générer un parcours"
                      : "Nouveau parcours"}
            </button>
          </div>
        </div>
      )}

      {/* ─── Route legend ────────────────────────────── */}
      {routeData && !isTracking && (
        <div className="glass-card absolute bottom-28 left-4 z-[1000] px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-accent-cyan">Départ</span>
            <div
              className="h-2 w-16 rounded-full"
              style={{
                background:
                  "linear-gradient(to right, hsl(170,90%,55%), hsl(85,90%,55%), hsl(40,90%,55%), hsl(0,90%,55%))",
              }}
            />
            <span className="font-medium text-accent-red">Arrivée</span>
          </div>
        </div>
      )}

      {/* ─── History button ──────────────────────────── */}
      {!isTracking && (
        <button
          onClick={toggleHistory}
          className="glass-card absolute top-[calc(env(safe-area-inset-top,0px)+1rem)] left-4 z-[1000] flex items-center gap-1.5 px-3 py-2 text-sm text-text-secondary transition-colors hover:text-accent-cyan"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Historique
        </button>
      )}

      {/* ─── Logout button ───────────────────────────── */}
      {!isTracking && (
        <button
          onClick={handleLogout}
          className="glass-card absolute top-[calc(env(safe-area-inset-top,0px)+1rem)] right-4 z-[1000] px-3 py-2 text-sm text-text-muted transition-colors hover:text-accent-red"
        >
          Déconnexion
        </button>
      )}

      {/* ─── History bottom sheet ────────────────────── */}
      {showHistory && (
        <div className="absolute inset-0 z-[1500]">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowHistory(false)}
          />
          {/* Sheet */}
          <div className="glass-card animate-slide-up safe-bottom absolute bottom-0 left-0 right-0 max-h-[60vh] overflow-y-auto p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-[family-name:var(--font-montserrat)] text-base font-bold text-text-primary">
                Historique
              </h3>
              <button
                onClick={() => setShowHistory(false)}
                className="text-text-muted transition-colors hover:text-text-primary"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {historyLoading ? (
              <div className="flex justify-center py-8">
                <div className="spinner" />
              </div>
            ) : historyRoutes.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-muted">
                Aucun parcours pour le moment
              </p>
            ) : (
              <div className="space-y-3">
                {historyRoutes.map((route) => (
                  <div
                    key={route.id}
                    className="rounded-xl bg-dark-surface/80 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs text-text-muted">
                        {formatDate(route.created_at)}
                      </span>
                      {statusBadge(route.status)}
                    </div>
                    <div className="mb-3 flex gap-4 text-sm">
                      <span className="text-text-primary">
                        <span className="font-semibold text-accent-cyan">
                          {(route.distance_m / 1000).toFixed(1)}
                        </span>{" "}
                        km
                      </span>
                      <span className="text-text-primary">
                        <span className="font-semibold text-accent-cyan">
                          {route.steps_estimate.toLocaleString()}
                        </span>{" "}
                        pas
                      </span>
                      {route.duration_s && (
                        <span className="text-text-primary">
                          <span className="font-semibold text-accent-cyan">
                            {formatDuration(route.duration_s)}
                          </span>
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {route.geometry && (
                        <button
                          onClick={() => viewHistoryRoute(route)}
                          className="flex-1 rounded-lg bg-dark-border py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:text-accent-cyan"
                        >
                          Voir sur la carte
                        </button>
                      )}
                      <button
                        onClick={() => redoRoute(route)}
                        className="flex-1 rounded-lg bg-accent-cyan/10 py-1.5 text-xs font-semibold text-accent-cyan transition-colors hover:bg-accent-cyan/20"
                      >
                        Refaire
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Error toast ─────────────────────────────── */}
      {(geoError || routeError) && (
        <div className="toast-error animate-fade-in-up absolute bottom-28 left-1/2 z-[1000] w-[85%] max-w-sm -translate-x-1/2 rounded-lg px-4 py-3 text-center text-sm">
          {geoError || routeError}
        </div>
      )}
    </div>
  );
}
