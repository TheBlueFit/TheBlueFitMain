"use client";

/**
 * Headless component (renders nothing). Keeps the athlete's health numbers fresh without any tapping:
 *  - when the app opens,
 *  - every time it comes back to the foreground (Android "appStateChange" / page visibility),
 *  - right after the user allows Health access.
 * It never shows a permission dialog by itself: if access was not allowed yet, the Health card on the
 * dashboard offers the "Allow" button.
 */
import { useEffect, useRef } from "react";
import { autoSyncIfAllowed, isNative } from "@/lib/healthSync";
import { usePermissions } from "@/components/shared/MobilePermissionsGate";

export default function HealthAutoSync() {
  const { permissions } = usePermissions();

  useEffect(() => {
    if (!isNative()) return;
    let cancelled = false;
    let handle: { remove: () => Promise<void> } | undefined;

    const run = () => {
      void autoSyncIfAllowed();
    };
    run();

    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);

    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const h = await App.addListener("appStateChange", ({ isActive }) => {
          if (isActive) run();
        });
        if (cancelled) await h.remove();
        else handle = h;
      } catch {
        /* browser build: visibilitychange above is enough */
      }
    })();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void handle?.remove();
    };
  }, []);

  // The moment access flips to "granted" (first-launch gate or the Allow button), sync straight away.
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const was = previous.current;
    previous.current = permissions.health;
    if (was !== null && was !== "granted" && permissions.health === "granted") {
      void autoSyncIfAllowed(true);
    }
  }, [permissions.health]);

  return null;
}
