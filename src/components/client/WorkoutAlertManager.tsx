"use client";
/**
 * WorkoutAlertManager.tsx  — src/components/client/WorkoutAlertManager.tsx
 *
 * FIXED: removed @capacitor/local-notifications (not installed).
 * Uses only the web Notification API which works on:
 *   - Android native (via WebView notification permission)
 *   - PWA (Chrome / Samsung Browser)
 *   - Desktop browser
 *
 * No new dependencies. Uses only what is already in package.json.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dumbbell, X } from "lucide-react";
import { dashboardAPI, getLocalDateISO } from "@/services/api";
import { useApp } from "@/components/shell/AppContext";

// ─── Config ──────────────────────────────────────────────────────────────────
const ALERT_HOURS    = [9, 18];      // fire at 09:00 and 18:00
const CHECK_INTERVAL = 60_000;       // poll every 60 s
const TOAST_DURATION = 7_000;        // auto-dismiss after 7 s

// ─── Types ────────────────────────────────────────────────────────────────────
interface Toast {
  id: number;
  title: string;
  body: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function fetchPendingCount(): Promise<{ count: number; names: string[] }> {
  try {
    const today = getLocalDateISO();
    const data   = await dashboardAPI.getAthleteData(undefined, today);
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

/** Show a native web Notification — works on Android WebView + PWA + desktop */
async function showNativeNotification(title: string, body: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission().catch(() => {});
  }
  if (Notification.permission === "granted") {
    try {
      new Notification(title, {
        body,
        icon: "/icons/logo-round-128.png",
        badge: "/icons/logo-round-128.png",
        tag: "bluefit-workout-reminder",   // replaces previous if still showing
      });
    } catch {
      // Silently ignore — some browsers block even after permission
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function WorkoutAlertManager() {
  const { session } = useApp();
  const signedIn    = session?.role === "CLIENT";

  const [toasts, setToasts]     = useState<Toast[]>([]);
  const shownHoursRef           = useRef<Set<string>>(new Set());
  const toastIdRef              = useRef(0);

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
    const h   = new Date().getHours();
    const key = `${getLocalDateISO()}-${h}`;

    if (!ALERT_HOURS.includes(h)) return;
    if (shownHoursRef.current.has(key)) return;

    const { count, names } = await fetchPendingCount();
    if (count === 0) return;

    shownHoursRef.current.add(key);

    const isEvening = h >= 17;
    const title = isEvening
      ? "💪 Don't forget your workout!"
      : "🌅 Today's workout is waiting";

    const body =
      count === 1
        ? `You still have "${names[0]}" to do today.`
        : count <= 3
        ? `Still to do: ${names.join(", ")}.`
        : `You have ${count} workouts remaining today.`;

    addToast(title, body);
    void showNativeNotification(title, body);
  }, [addToast]);

  useEffect(() => {
    if (!signedIn) return;
    void check();
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
        top: "calc(env(safe-area-inset-top, 0px) + 72px)",
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
function ToastBanner({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}) {
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
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgb(var(--gold-rgb, 229 184 105) / 0.12)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(-10px)",
        transition:
          "opacity 0.35s ease, transform 0.35s cubic-bezier(0.16,1,0.3,1)",
      }}
    >
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

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "var(--text-primary)",
            lineHeight: 1.3,
            marginBottom: 3,
          }}
        >
          {toast.title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          {toast.body}
        </div>
      </div>

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
