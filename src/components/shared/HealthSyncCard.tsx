"use client";

/**
 * HealthSyncCard (v5)
 * Shows the phone's health numbers. The reading itself is done by lib/healthSync.ts, which also runs
 * automatically whenever the app opens (see components/client/HealthAutoSync.tsx), so this card is
 * normally already up to date; "Sync now" is only for an immediate refresh.
 *
 * Today = real totals (saved to the server). 7 / 30 days = per-day averages (view only, never saved).
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Activity, RefreshCw, Smartphone, CheckCircle2, AlertCircle, Heart } from "lucide-react";

import { usePermissions } from "@/components/shared/MobilePermissionsGate";
import AppleHealthSetup from "@/components/shared/AppleHealthSetup";
import {
  getHealthStatus,
  isNative,
  healthStore,
  syncHealth,
  autoSyncIfAllowed,
  openHealthSettings,
  openHealthConnectInstall,
  type HealthStatus,
  type HealthReading,
  type SyncRange,
} from "@/lib/healthSync";

const RANGE_LABELS: Record<SyncRange, string> = { today: "Today", "7d": "7 Days", "30d": "30 Days" };

function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export default function HealthSyncCard({ onSync }: { onSync?: (data: HealthReading) => void }) {
  const { requestPermission } = usePermissions();
  const snap = useSyncExternalStore(healthStore.subscribe, healthStore.get, healthStore.get);
  const [status, setStatus] = useState<HealthStatus | "checking">("checking");
  const access = status === "checking" ? "checking" : status.permission;
  const [range, setRange] = useState<SyncRange>("today");

  const onSyncRef = useRef(onSync);
  useEffect(() => { onSyncRef.current = onSync; }, [onSync]);

  // What the OS says right now. Re-checked when the app returns to the foreground (for example after the user
  // allowed access in Health Connect settings or installed Health Connect from the Play Store).
  useEffect(() => {
    let alive = true;
    const check = () => getHealthStatus().then((st) => {
      if (!alive) return;
      setStatus(st);
      if (st.permission === "granted") void autoSyncIfAllowed();
    });
    check();
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    let handle: { remove: () => Promise<void> } | undefined;
    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const h = await App.addListener("appStateChange", ({ isActive }) => { if (isActive) check(); });
        if (alive) handle = h; else await h.remove();
      } catch { /* browser build */ }
    })();
    return () => { alive = false; document.removeEventListener("visibilitychange", onVisible); void handle?.remove(); };
  }, []);

  // Dashboard numbers follow every finished "today" sync, whoever started it (auto or button).
  const lastPushed = useRef<string | undefined>(undefined);
  useEffect(() => {
    const r = snap.reading;
    if (snap.status === "done" && r?.range === "today" && r.lastSynced !== lastPushed.current) {
      lastPushed.current = r.lastSynced;
      onSyncRef.current?.(r);
    }
  }, [snap]);

  const syncing = snap.status === "syncing";
  const reading = snap.reading;

  const choose = (r: SyncRange) => {
    setRange(r);
    if (!syncing && access === "granted") void syncHealth(r);
  };

  if (access === "checking") return null;

  const issue = status === "checking" ? null : status.issue;
  const buttonStyle: React.CSSProperties = { padding: "8px 14px", background: "rgb(var(--gold-rgb) / 0.15)", border: "1px solid rgb(var(--gold-rgb) / 0.4)", borderRadius: 8, color: "var(--accent-gold)", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
  const boxStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "rgb(var(--gold-rgb) / 0.06)", border: "1px solid rgb(var(--gold-rgb) / 0.25)", borderRadius: "var(--radius-md)" };
  const refresh = async () => setStatus(await getHealthStatus());

  if (access === "prompt") {
    // Android stopped showing the pop-up: the only way forward is Health Connect's own settings screen.
    if (issue === "blocked") {
      return (
        <div style={boxStyle}>
          <Heart size={18} color="var(--accent-gold)" />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 2px" }}>Allow access in Health Connect</p>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>Android will not show the pop-up again. Open Health Connect, tap App permissions, choose The Blue Fit and allow Steps, Sleep, Active calories and Heart rate. Then come back here.</p>
          </div>
          <button type="button" onClick={() => void openHealthSettings()} style={buttonStyle}>Open settings</button>
        </div>
      );
    }
    return (
      <div style={boxStyle}>
        <Heart size={18} color="var(--accent-gold)" />
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 2px" }}>Turn on automatic health sync</p>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>Allow Health access once; your steps, sleep and heart rate then update every time you open the app.</p>
        </div>
        <button type="button"
          onClick={async () => { await requestPermission("health"); await refresh(); void autoSyncIfAllowed(true); }}
          style={buttonStyle}>
          Allow
        </button>
      </div>
    );
  }

  // iPhone web app: Apple Health cannot be read from a web page, so sync runs through an iOS Shortcut.
  if (access === "unavailable" && !isNative() && isIOSDevice()) return <AppleHealthSetup />;
  if (access === "unavailable" && isNative() && isIOSDevice() && issue === null) return <AppleHealthSetup />;

  if (access === "unavailable") {
    const detail = status !== "checking" ? status.detail : undefined;
    let text = "Health sync works in the Android and iPhone app. Open the app on your phone to sync.";
    let action: { label: string; run: () => void } | null = null;
    if (isNative()) {
      if (issue === "not-installed") {
        text = "Health Connect is not installed on this phone. Install it from the Play Store, then come back and tap Allow.";
        action = { label: "Install", run: openHealthConnectInstall };
      } else if (issue === "update-required") {
        text = "Health Connect needs an update before The Blue Fit can read your steps and sleep.";
        action = { label: "Update", run: openHealthConnectInstall };
      } else if (issue === "no-plugin") {
        text = "This build of the app does not include the health plugin. Rebuild it with npm run build and npx cap sync android, then reinstall the APK.";
      } else {
        text = "Health Connect is not available on this phone.";
        action = { label: "Retry", run: () => void refresh() };
      }
    }
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "rgb(var(--ink-rgb) / 0.03)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)", color: "var(--text-secondary)", fontSize: 13 }}>
        <Smartphone size={16} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <span>{text}</span>
          {isNative() && detail && <span style={{ display: "block", fontSize: 11, opacity: 0.7, marginTop: 2 }}>{detail}</span>}
        </div>
        {action && <button type="button" onClick={action.run} style={buttonStyle}>{action.label}</button>}
      </div>
    );
  }

  const shown = reading && reading.range === range ? reading : null;
  const avg = range !== "today";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 16px", background: "rgb(var(--ink-rgb) / 0.03)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 4, background: "rgb(var(--ink-rgb) / 0.05)", borderRadius: 8, padding: 3 }}>
          {(Object.keys(RANGE_LABELS) as SyncRange[]).map((r) => (
            <button key={r} type="button" onClick={() => choose(r)}
              style={{ padding: "4px 10px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: range === r ? 700 : 400, cursor: "pointer",
                background: range === r ? "rgb(var(--gold-rgb) / 0.18)" : "transparent", color: range === r ? "var(--accent-gold)" : "var(--text-secondary)", transition: "all 0.15s" }}>
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => void syncHealth(range)} disabled={syncing}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", background: "rgb(var(--ink-rgb) / 0.06)", border: "1px solid var(--border-subtle)", borderRadius: 8, color: "var(--text-primary)", fontSize: 12, cursor: syncing ? "wait" : "pointer" }}>
          <RefreshCw size={13} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {snap.status === "done" && <CheckCircle2 size={15} color="var(--accent-green)" style={{ flexShrink: 0 }} />}
        {snap.status === "error" && <AlertCircle size={15} color="var(--danger)" style={{ flexShrink: 0 }} />}
        {(snap.status === "idle" || syncing) && <Activity size={15} color="var(--accent-gold)" style={{ flexShrink: 0 }} />}
        <div>
          <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>
            {syncing && `Syncing ${RANGE_LABELS[range].toLowerCase()} data…`}
            {!syncing && snap.status === "error" && (snap.error || "Could not read health data")}
            {!syncing && snap.status !== "error" && shown && (
              <>
                {shown.steps != null && `${shown.steps.toLocaleString()} steps`}
                {shown.sleepHours != null && ` · ${shown.sleepHours}h sleep`}
                {shown.calories != null && ` · ${shown.calories} kcal`}
                {shown.heartRate != null && ` · ${shown.heartRate} bpm`}
                {avg && " (per day)"}
              </>
            )}
            {!syncing && snap.status !== "error" && !shown && `Syncs automatically when you open the app`}
          </span>
          {!syncing && shown?.lastSynced && (
            <span style={{ fontSize: 11, color: "var(--text-secondary)", display: "block" }}>
              Synced {new Date(shown.lastSynced).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {avg && ` · ${RANGE_LABELS[range]} average (not saved)`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
