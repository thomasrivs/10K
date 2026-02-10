"use client";

import { useState, useEffect } from "react";
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

// ─── Types ───────────────────────────────────────────────────

type AppMode =
  | "idle"
  | "locating"
  | "positioned"
  | "generating"
  | "route_shown";

interface RouteData {
  id: string | null;
  distance_m: number;
  duration_s: number;
  steps_estimate: number;
  geometry: GeoJSON.LineString;
  routes_used: number;
  routes_limit: number;
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

// ─── Map helpers ─────────────────────────────────────────────

function FlyToPosition({ position }: { position: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo(position, 15);
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

// ─── Main Component ──────────────────────────────────────────

export default function Map() {
  const [appMode, setAppMode] = useState<AppMode>("idle");
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [routeData, setRouteData] = useState<RouteData | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  const supabase = createClient();
  const router = useRouter();

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

  // ─── Main action handler ───────────────────────────────
  const handleMainAction = () => {
    if (appMode === "idle") {
      requestLocation();
    } else if (appMode === "positioned") {
      generateRoute();
    } else if (appMode === "route_shown") {
      generateRoute();
    }
  };

  return (
    <div className="relative h-full w-full">
      {/* ─── Map ─────────────────────────────────────── */}
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        {/* Fly to user position */}
        {userPosition && !routeData && (
          <FlyToPosition position={userPosition} />
        )}

        {/* User position circle (before route) */}
        {userPosition && !routeData && (
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
        {userPosition && routeData && (
          <Marker position={userPosition} icon={startIcon}>
            <Popup>Départ / Arrivée</Popup>
          </Marker>
        )}

        {/* Route display */}
        {routeData?.geometry && (
          <>
            <GradientRoute geometry={routeData.geometry} />
            <RouteArrows geometry={routeData.geometry} />
            <FitRouteBounds geometry={routeData.geometry} />
          </>
        )}
      </MapContainer>

      {/* ─── Route info panel ────────────────────────── */}
      {routeData && (
        <div className="glass-card animate-fade-in-up safe-top absolute top-4 left-1/2 z-[1000] w-[90%] max-w-sm -translate-x-1/2 px-4 py-3">
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

      {/* ─── Action buttons ──────────────────────────── */}
      {!limitReached && (
        <div className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom,0px))] left-1/2 z-[1000] flex -translate-x-1/2 gap-3">
          <button
            onClick={handleMainAction}
            disabled={appMode === "locating" || appMode === "generating"}
            className="animate-fade-in-up flex items-center justify-center gap-2 rounded-full px-6 py-4 text-base font-bold shadow-lg transition-all active:scale-95 disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, #00f5d4, #00e676)", color: "#1a1a2e" }}
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
      )}

      {/* ─── Route legend ────────────────────────────── */}
      {routeData && (
        <div className="glass-card absolute bottom-24 left-4 z-[1000] px-3 py-2">
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

      {/* ─── Logout button ───────────────────────────── */}
      <button
        onClick={handleLogout}
        className="glass-card safe-top absolute top-4 right-4 z-[1000] px-3 py-2 text-sm text-text-muted transition-colors hover:text-accent-red"
      >
        Déconnexion
      </button>

      {/* ─── Error toast ─────────────────────────────── */}
      {(geoError || routeError) && (
        <div className="toast-error animate-fade-in-up absolute bottom-28 left-1/2 z-[1000] w-[85%] max-w-sm -translate-x-1/2 rounded-lg px-4 py-3 text-center text-sm">
          {geoError || routeError}
        </div>
      )}
    </div>
  );
}
