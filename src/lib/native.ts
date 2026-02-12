/**
 * Native services abstraction layer.
 * Wraps Capacitor plugins (GPS, pedometer) with web fallbacks.
 * When running in the browser, falls back to Web APIs.
 * When running inside the Capacitor native shell, uses native plugins.
 */

let _isNative: boolean | null = null;

/** Check if running inside Capacitor native shell */
export function isNativePlatform(): boolean {
  if (_isNative !== null) return _isNative;
  try {
    // Capacitor injects window.Capacitor when running in native shell
    _isNative = !!(window as any).Capacitor?.isNativePlatform?.();
  } catch {
    _isNative = false;
  }
  return _isNative;
}

// ─── Pedometer ──────────────────────────────────────────────

type PedometerCallback = (steps: number, distance: number) => void;

let pedometerListener: { remove: () => Promise<void> } | null = null;

/** Start receiving real-time step count updates from CMPedometer (iOS). */
export async function startPedometer(callback: PedometerCallback): Promise<boolean> {
  if (!isNativePlatform()) return false;

  try {
    const { CapacitorPedometer } = await import("@capgo/capacitor-pedometer");

    // Check availability
    const { stepCounting } = await CapacitorPedometer.isAvailable();
    if (!stepCounting) return false;

    // Request permission
    const { activityRecognition } = await CapacitorPedometer.checkPermissions();
    if (activityRecognition !== "granted") {
      const result = await CapacitorPedometer.requestPermissions();
      if (result.activityRecognition !== "granted") return false;
    }

    // Listen for measurement events
    pedometerListener = await CapacitorPedometer.addListener("measurement", (event) => {
      callback(event.numberOfSteps ?? 0, event.distance ?? 0);
    });

    // Start updates
    await CapacitorPedometer.startMeasurementUpdates();
    return true;
  } catch {
    return false;
  }
}

/** Stop pedometer updates. */
export async function stopPedometer(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { CapacitorPedometer } = await import("@capgo/capacitor-pedometer");
    await CapacitorPedometer.stopMeasurementUpdates();
    if (pedometerListener) {
      await pedometerListener.remove();
      pedometerListener = null;
    }
  } catch {
    // Ignore
  }
}

// ─── Geolocation ────────────────────────────────────────────

type GeoCallback = (lat: number, lng: number, heading: number | null) => void;
type GeoErrorCallback = () => void;

let geoWatchId: string | null = null;

/**
 * Start watching position using native GPS (Capacitor) or web fallback.
 * On native, uses @capacitor/geolocation which provides better accuracy
 * and can work with iOS background location mode.
 */
export async function startWatchPosition(
  onPosition: GeoCallback,
  onError: GeoErrorCallback
): Promise<{ isNative: boolean; webWatchId: number | null }> {
  if (isNativePlatform()) {
    try {
      const { Geolocation } = await import("@capacitor/geolocation");

      // Request permission (needed on native)
      await Geolocation.requestPermissions({ permissions: ["location"] });

      geoWatchId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 },
        (position, err) => {
          if (err || !position) {
            onError();
            return;
          }
          onPosition(
            position.coords.latitude,
            position.coords.longitude,
            position.coords.heading
          );
        }
      );

      return { isNative: true, webWatchId: null };
    } catch {
      // Fall through to web
    }
  }

  // Web fallback
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      onPosition(
        pos.coords.latitude,
        pos.coords.longitude,
        pos.coords.heading
      );
    },
    () => onError(),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
  );

  return { isNative: false, webWatchId: id };
}

/** Stop watching position. */
export async function stopWatchPosition(webWatchId: number | null): Promise<void> {
  if (geoWatchId !== null) {
    try {
      const { Geolocation } = await import("@capacitor/geolocation");
      await Geolocation.clearWatch({ id: geoWatchId });
      geoWatchId = null;
    } catch {
      // Ignore
    }
  }
  if (webWatchId !== null) {
    navigator.geolocation.clearWatch(webWatchId);
  }
}

/**
 * Get current position (one-shot) using native or web API.
 */
export async function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (isNativePlatform()) {
    try {
      const { Geolocation } = await import("@capacitor/geolocation");
      await Geolocation.requestPermissions({ permissions: ["location"] });
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch {
      // Fall through to web
    }
  }

  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}
