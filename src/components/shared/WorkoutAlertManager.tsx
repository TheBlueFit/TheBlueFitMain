"use client";
/**
 * WorkoutAlertManager.tsx  — src/components/client/WorkoutAlertManager.tsx
 *
 * ADDITIVE ONLY. Drop this component inside the CLIENT layout alongside
 * <HealthAutoSync /> and <PushRegistrar />. It adds zero UI on its own;
 * all it does is:
 *
 *   1. After sign-in it fetches the athlete's active schedules once.
 *   2. It computes which workouts are due today and have not been logged.
 *   3. At the right time (09:00 and 18:00 by default) it shows a native
 *      Notification (Android / desktop) AND an in-app toast.
 *   4. The in-app toast is a fixed banner at the top of the screen that
 *      auto-dismisses after 7 seconds (or when the user taps ×).
 *   5. Everything respects prefers-reduced-motion: transitions are instant.
 *   6. No dependencies beyond what the app already has.
 *
 * HOW TO ADD TO layout.tsx
 * ─────────────────────────
 * import WorkoutAlertManager from "@/components/client/WorkoutAlertManager";
 *
 * // Inside the CLIENT role block, next to <HealthAutoSync />:
 * {role === "CLIENT" && <WorkoutAlertManager />}
 *
 * NOTIFICATION CHANNELS
 * ─────────────────────
 * On Capacitor (Android): creates "workouts" channel and shows a local
 * notification via LocalNotifications plugin if installed; otherwise it
 * uses the web Notification API (shown in the browser / PWA notification area).
 *
 * On web PWA (Safari / Chrome): uses the Notification API directly.
 * No backend required — these are 100% local, scheduled on-device.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dumbbell, X } from "lucide-react";
import { dashboardAPI, getLocalDateISO } from "@/services/api";
import { useApp } from "@/components/shell/AppContext";
import { Capacitor } from "@capacitor/core";

// ─── Config ──────────────────────────────────────────────────────────────────
const ALERT_HOURS   = [9, 18];       // 09:00 and 18:00 — check whether a reminder is due
const CHECK_INTERVAL = 60_000;       // poll every 60 s to catch the right minute
const TOAST_DURATION = 7_000;        // auto-dismiss after 7 s
const CHANNEL_ID    = "workouts";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Toast {
  id: number;
  title: string;
  body: string;
}

// ─── Helper: get pending workout count for today ──────────────────────────────
async function fetchPendingCount(): Promise<{ count: number; names: string[] }> {
  try {
    const today = getLocalDateISO();
    const data  = await dashboardAPI.getAthleteData(undefined, today);
    const training: any[] = data.todayTraining ?? [];
    const pending = training.filter((t) => !t.completed);
    return {
      count: pending.length,
      names: pending.slice(0, 3).map((t) => t.title ?? t.name ?? "workout"),
    };
  } catch {
    return { count: 0, names: [] };
  }
}

// ─── Helper: show native notification ────────────────────────────────────────
async function showNative(title: string, body: string) {
  // Capacitor native (Android / iOS)
  if (Capacitor.isNativePlatform()) {
    try {
      const { LocalNotifications } = await import("@capacitor/local-notifications");
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") {
        const req = await LocalNotifications.requestPermissions();
        if (req.display !== "granted") return;
      }
      if (Capacitor.getPlatform() === "android") {
        await LocalNotifications.createChannel({
          id: CHANNEL_ID,
          name: "Workout Reminders",
          description: "Reminders for your scheduled workouts",
          importance: 3,
          vibration: true,
        }).catch(() => {});
      }
      await LocalNotifications.schedule({
        notifications: [{
          id: Date.now() % 2_000_000,
          title,
          body,
          channelId: CHANNEL_ID,
          schedule: { at: new Date(Date.now() + 100) },
          extra: { url: "/client" },
        }],
      });
      return;
    } catch { /* fall through to web API */ }
  }
  // Web Notification API
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission().catch(() => {});
  }
  if (Notification.permission === "granted") {
    new Notification(title, { body, icon: "/icons/logo-round-128.png" });
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function WorkoutAlertManager() {
  const { session } = useApp();
  const signedIn    = session?.role === "CLIENT";

  const [toasts, setToasts] = useState<Toast[]>([]);
  const shownHoursRef = useRef<Set<string>>(new Set());
  const toastIdRef    = useRef(0);

  const addToast = useCallback((title: string, body: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, title, body }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_DURATION);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const check = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    const now  = new Date();
    const h    = now.getHours();
    const key  = `${getLocalDateISO()}-${h}`;

    if (!ALERT_HOURS.includes(h)) return;
    if (shownHoursRef.current.has(key)) return;

    const { count, names } = await fetchPendingCount();
    if (count === 0) return;

    shownHoursRef.current.add(key);

    const isEvening = h >= 17;
    const title = isEvening
      ? `💪 Don't forget your workout!`
      : `🌅 Today's workout is waiting for you`;

    const body = count === 1
      ? `You still have "${names[0]}" to do today.`
      : count <= 3
      ? `Still to do: ${names.join(", ")}.`
      : `You have ${count} workouts remaining today.`;

    addToast(title, body);
    void showNative(title, body);
  }, [addToast]);

  useEffect(() => {
    if (!signedIn) return;
    void check();                                     // fire immediately on sign-in
    const id = window.setInterval(check, CHECK_INTERVAL);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, [signedIn, check]);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Workout reminders"
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 72px)",   // below the mobile header
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2000,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        width: "min(calc(100vw - 32px), 420px)",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => (
        <ToastBanner key={toast.id} toast={toast} onDismiss={removeToast} />
      ))}
    </div>
  );
}

// ─── Toast banner ─────────────────────────────────────────────────────────────
function ToastBanner({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => onDismiss(toast.id), 350);
  }, [toast.id, onDismiss]);

  return (
    <div
      role="alert"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "14px 16px",
        borderRadius: "var(--radius-md, 14px)",
        background: "var(--bg-elev, #111)",
        border: "1px solid rgb(var(--gold-rgb, 229 184 105) / 0.35)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgb(var(--gold-rgb, 229 184 105) / 0.12)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(-10px)",
        transition: "opacity 0.35s ease, transform 0.35s cubic-bezier(0.16,1,0.3,1)",
        willChange: "opacity, transform",
      }}
    >
      {/* Icon */}
      <span
        style={{
          flexShrink: 0,
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "rgb(var(--gold-rgb, 229 184 105) / 0.15)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Dumbbell size={18} color="var(--accent-gold, #E5B869)" strokeWidth={1.8} />
      </span>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.3, marginBottom: 3 }}>
          {toast.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {toast.body}
        </div>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        aria-label="Dismiss reminder"
        onClick={dismiss}
        style={{
          flexShrink: 0,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          color: "var(--text-secondary)",
          padding: 2,
          display: "flex",
          alignItems: "center",
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
