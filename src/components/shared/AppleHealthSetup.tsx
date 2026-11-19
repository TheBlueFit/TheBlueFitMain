"use client";

/**
 * AppleHealthSetup
 * ─────────────────
 * Safari / home-screen web apps cannot read Apple Health (HealthKit is native-only), so iPhone
 * athletes sync through an iOS Shortcut. This card makes that a one-time, three-tap job:
 *   1. "Turn on" → we create a personal sync key (only able to write this athlete's own daily numbers)
 *   2. "Copy key" + "Get the shortcut" → the shortcut asks for the key once when it is added
 *   3. Add the daily automation → from then on it syncs by itself
 *
 * Set NEXT_PUBLIC_IOS_SHORTCUT_URL to the iCloud share link of the Blue Fit shortcut. Without it the
 * card shows the manual recipe instead.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Apple, CheckCircle2, Copy, ExternalLink, KeyRound, ChevronDown } from "lucide-react";
import { dashboardAPI } from "@/services/api";

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const SHORTCUT_URL = process.env.NEXT_PUBLIC_IOS_SHORTCUT_URL || "";
const INGEST_URL = `${API_BASE_URL}/health-sync/ingest`;

type Status = { enabled: boolean; createdAt?: string; lastUsedAt?: string } | null;

const box: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 12, padding: "14px 16px",
  background: "rgb(var(--ink-rgb) / 0.03)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)",
};
const btn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, cursor: "pointer",
  background: "rgb(var(--gold-rgb) / 0.15)", border: "1px solid rgb(var(--gold-rgb) / 0.4)",
  color: "var(--accent-gold)", fontSize: 12, fontWeight: 700, textDecoration: "none",
};
const ghost: React.CSSProperties = { ...btn, background: "rgb(var(--ink-rgb) / 0.06)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)", fontWeight: 500 };
const mono: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11, wordBreak: "break-all", background: "rgb(var(--ink-rgb) / 0.06)", padding: "6px 8px", borderRadius: 6, display: "block", userSelect: "all" };

function ago(iso?: string) {
  if (!iso) return null;
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

export default function AppleHealthSetup() {
  const [status, setStatus] = useState<Status>(null);
  const [key, setKey] = useState<string | null>(null);   // only held in memory, shown once
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);

  const load = useCallback(() => {
    dashboardAPI.getHealthSyncStatus().then(setStatus).catch(() => setStatus({ enabled: false }));
  }, []);
  useEffect(() => { load(); }, [load]);
  // pick up the first sync as soon as the shortcut has run
  useEffect(() => {
    if (!status?.enabled || status.lastUsedAt) return;
    const id = window.setInterval(load, 8000);
    return () => window.clearInterval(id);
  }, [status?.enabled, status?.lastUsedAt, load]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* user can long-press the key */ }
  };

  const turnOn = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await dashboardAPI.createHealthSyncKey();
      setKey(res.key); await copy(res.key); load();
    } catch (e: any) { setErr(e?.message || "Could not create the key."); }
    finally { setBusy(false); }
  };

  const turnOff = async () => {
    setBusy(true); setErr(null);
    try { await dashboardAPI.revokeHealthSyncKey(); setKey(null); load(); }
    catch (e: any) { setErr(e?.message || "Could not turn sync off."); }
    finally { setBusy(false); }
  };

  const bodyTemplate = `{\n  "steps": [Steps],\n  "calories": [Active Calories],\n  "heartRate": [Avg Heart Rate],\n  "sleepMinutes": [Sleep Minutes],\n  "date": "[Date, yyyy-MM-dd]"\n}`;

  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Apple size={17} color="var(--accent-gold)" />
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Apple Health sync</p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
            {status?.enabled
              ? status.lastUsedAt ? `Connected · last sync ${ago(status.lastUsedAt)}` : "Key created · waiting for the first sync"
              : "Syncs steps, sleep, calories and heart rate from your iPhone automatically."}
          </p>
        </div>
        {status?.enabled && status.lastUsedAt && <CheckCircle2 size={16} color="var(--accent-green)" />}
      </div>

      {!status?.enabled && (
        <button type="button" style={btn} onClick={turnOn} disabled={busy}>
          <KeyRound size={13} />{busy ? "Setting up…" : "Turn on Apple Health sync"}
        </button>
      )}

      {status?.enabled && (
        <>
          {key && (
            <div>
              <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--text-secondary)" }}>
                Your key {copied ? "(copied ✓)" : ""} — shown once. Paste it when the shortcut asks.
              </p>
              <code style={mono}>{key}</code>
            </div>
          )}
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 6 }}>
            <li>Add the Blue Fit shortcut and paste your key when asked. Allow Health access once.</li>
            <li>Shortcuts → <b>Automation</b> → <b>+</b> → Time of Day (e.g. 9 PM) → Run Shortcut → <b>Run Immediately</b>.</li>
          </ol>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {key && <button type="button" style={ghost} onClick={() => copy(key)}><Copy size={13} />{copied ? "Copied" : "Copy key"}</button>}
            {SHORTCUT_URL && <a href={SHORTCUT_URL} style={btn}><ExternalLink size={13} />Get the shortcut</a>}
            <button type="button" style={ghost} onClick={turnOn} disabled={busy}>{key ? "New key" : "Get a new key"}</button>
            <button type="button" style={ghost} onClick={turnOff} disabled={busy}>Turn off</button>
          </div>

          <button type="button" onClick={() => setManual(m => !m)}
            style={{ ...ghost, background: "transparent", border: "none", padding: 0, color: "var(--text-secondary)", fontSize: 12 }}>
            <ChevronDown size={14} style={{ transform: manual ? "rotate(180deg)" : "none" }} />
            {SHORTCUT_URL ? "Build it by hand instead" : "How to build the shortcut"}
          </button>
          {manual && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              <p style={{ margin: 0 }}>In the Shortcuts app, create a shortcut with these actions:</p>
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
                <li><b>Find Health Samples</b> (Steps, Start Date is Today) → <b>Calculate Statistics</b> (Sum). Repeat for Active Energy (Sum), Heart Rate (Average) and Sleep (Sum of duration, minutes).</li>
                <li><b>Format Date</b> (Current Date, custom <code>yyyy-MM-dd</code>).</li>
                <li><b>Get Contents of URL</b> → Method <b>POST</b>, Header <code>Authorization</code> = <code>Bearer </code> + your key, Request Body <b>JSON</b> with the fields below.</li>
              </ol>
              <span>URL</span><code style={mono}>{INGEST_URL}</code>
              <span>JSON body</span><code style={{ ...mono, whiteSpace: "pre-wrap" }}>{bodyTemplate}</code>
              <p style={{ margin: 0 }}>Any field you leave out is simply skipped. iPhone may hold Health data back while locked, so pick an automation time when you are usually using the phone.</p>
            </div>
          )}
        </>
      )}
      {err && <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>{err}</p>}
    </div>
  );
}
