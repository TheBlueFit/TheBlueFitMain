"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, HardDrive, Loader2, RefreshCw, ScanSearch, Square } from "lucide-react";
import { CleanupPreview, CleanupRunResult, CleanupRunRow, dashboardAPI } from "@/services/api";

const CATS = [
  { id: "mealPhotos", label: "3-day meal log photos" },
  { id: "templateImages", label: "Coach template images" },
];

export const fmtBytes = (n?: number | null) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
};

const pill: React.CSSProperties = { flexDirection: "column", alignItems: "flex-start", padding: "14px", gap: "6px" };
const field: React.CSSProperties = { background: "rgb(var(--well-rgb) / 0.4)", border: "1px solid var(--border-subtle)", borderRadius: 10, color: "var(--text-primary)", padding: "10px 12px", fontSize: 16, outline: "none", width: "100%", boxSizing: "border-box" };

export default function StorageCleanup() {
  const [days, setDays] = useState(15);
  const [cats, setCats] = useState<string[]>(["mealPhotos", "templateImages"]);
  const [retryFailed, setRetryFailed] = useState(false);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ handled: 0, total: 0 });
  const [totals, setTotals] = useState<{ converted: number; failed: number; nogain: number; before: number; after: number } | null>(null);
  const [errors, setErrors] = useState<{ file: string; reason: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CleanupRunRow[]>([]);
  const stopRef = useRef(false);

  const loadHistory = useCallback(() => { dashboardAPI.cleanupHistory().then((r) => setHistory(r.runs)).catch(() => {}); }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const daysOk = Number.isInteger(days) && days >= 7 && days <= 3650;
  const toggleCat = (id: string) => { setPreview(null); setTotals(null); setCats((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id])); };

  const scan = async () => {
    setError(null); setTotals(null); setErrors([]); setConfirming(false); setScanning(true);
    try { setPreview(await dashboardAPI.cleanupPreview(days, cats, retryFailed)); }
    catch (e: any) { setError(e.message || "Could not scan."); setPreview(null); }
    finally { setScanning(false); }
  };

  const run = async () => {
    if (!preview) return;
    setConfirming(false); setRunning(true); setError(null); stopRef.current = false; setErrors([]);
    const total = preview.total.count;
    setProgress({ handled: 0, total });
    const sum = { converted: 0, failed: 0, nogain: 0, before: 0, after: 0 };
    const errs: { file: string; reason: string }[] = [];
    let handled = 0; let runId: string | undefined;
    try {
      for (let guard = 0; guard < 500; guard++) {
        const r: CleanupRunResult = await dashboardAPI.cleanupRun({ days, categories: cats, runId, retryFailed });
        runId = r.runId; handled += r.handled;
        sum.converted += r.converted; sum.failed += r.failed; sum.nogain += r.nogain; sum.before += r.bytesBefore; sum.after += r.bytesAfter;
        errs.push(...r.errors);
        setProgress({ handled: Math.min(handled, total), total }); setTotals({ ...sum }); setErrors([...errs]);
        if (r.done || stopRef.current || r.handled === 0) break;
      }
    } catch (e: any) { setError(e.message || "The cleanup stopped unexpectedly. Nothing was lost; you can run it again."); }
    finally { setRunning(false); setPreview(null); loadHistory(); }
  };

  const pct = progress.total ? Math.round((progress.handled / progress.total) * 100) : 0;
  const saved = totals ? totals.before - totals.after : 0;

  return (
    <div className="fade-in">
      <div className="section-header" style={{ marginBottom: 8 }}><h2 style={{ fontSize: 16 }}>Storage cleanup</h2></div>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 18 }}>
        Shrinks old photos to WebP to free storage. Each original is deleted only after its smaller copy is saved and checked, and every record is re-pointed so photos keep opening
        exactly as before. Weekly progress photos are never touched.
      </p>

      <div className="macro-pill" style={{ ...pill, alignItems: "stretch", gap: 16, padding: 16 }}>
        <div>
          <span className="plan-item-category" style={{ margin: 0, display: "block", marginBottom: 8 }}>Convert photos older than</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input type="number" inputMode="numeric" min={7} max={3650} value={days} onChange={(e) => { setDays(Number(e.target.value)); setPreview(null); }} style={{ ...field, width: 96 }} aria-label="Days" />
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>days</span>
            {[7, 15, 30, 60].map((d) => (
              <button key={d} type="button" onClick={() => { setDays(d); setPreview(null); }} className={days === d ? "btn-primary" : "btn-secondary"} style={{ padding: "8px 12px", fontSize: 12, flex: "none" }}>{d}</button>
            ))}
          </div>
          {!daysOk && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 8 }}>Enter a whole number from 7 to 3650.</div>}
        </div>

        <div>
          <span className="plan-item-category" style={{ margin: 0, display: "block", marginBottom: 8 }}>What to include</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {CATS.map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={cats.includes(c.id)} onChange={() => toggleCat(c.id)} style={{ width: 18, height: 18, accentColor: "var(--accent-gold)" }} /> {c.label}
              </label>
            ))}
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={retryFailed} onChange={(e) => { setRetryFailed(e.target.checked); setPreview(null); }} style={{ width: 16, height: 16, accentColor: "var(--accent-gold)" }} />
          Also retry photos that failed in an earlier run
        </label>

        <button type="button" className="btn-secondary" onClick={scan} disabled={scanning || running || !daysOk || !cats.length}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px" }}>
          {scanning ? <Loader2 size={16} className="spin" /> : <ScanSearch size={16} />} {scanning ? "Scanning…" : "Scan (changes nothing)"}
        </button>
      </div>

      {error && <div className="error-banner" style={{ marginTop: 14 }}>{error}</div>}

      {preview && !running && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <div className="macro-pill" style={pill}><span className="plan-item-category" style={{ margin: 0 }}>Photos to convert</span><strong style={{ fontSize: 24 }}>{preview.total.count}</strong></div>
            <div className="macro-pill" style={pill}><span className="plan-item-category" style={{ margin: 0 }}>Current size</span><strong style={{ fontSize: 24 }}>{fmtBytes(preview.total.bytes)}</strong></div>
            <div className="macro-pill" style={pill}><span className="plan-item-category" style={{ margin: 0 }}>Estimated saving</span><strong style={{ fontSize: 24, color: "var(--accent-green)" }}>~{fmtBytes(preview.total.estimatedSavedBytes)}</strong></div>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 10 }}>
            {CATS.filter((c) => preview.categories[c.id]).map((c) => `${c.label}: ${preview.categories[c.id].count}`).join(" · ")}
            {preview.parkedFailed > 0 && !retryFailed ? ` · ${preview.parkedFailed} skipped after an earlier failure` : ""}. The saving is an estimate; exact figures appear after the run.
          </p>

          {preview.total.count === 0 ? (
            <div className="macro-pill" style={{ marginTop: 12, gap: 10 }}><CheckCircle2 size={18} color="var(--accent-green)" /> Nothing to clean up for these settings.</div>
          ) : !confirming ? (
            <button type="button" className="btn-primary" onClick={() => setConfirming(true)} style={{ marginTop: 14, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px" }}>
              <HardDrive size={16} /> Convert &amp; free space
            </button>
          ) : (
            <div style={{ marginTop: 14, padding: 16, borderRadius: 14, border: "1px solid rgb(var(--gold-rgb) / 0.4)", background: "rgb(var(--gold-rgb) / 0.08)" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <AlertTriangle size={20} color="var(--accent-gold)" style={{ flex: "none", marginTop: 2 }} />
                <div style={{ fontSize: 13, lineHeight: 1.55 }}>
                  <strong>Convert {preview.total.count} photo{preview.total.count === 1 ? "" : "s"} and delete the originals?</strong><br />
                  Photos will be resized to at most 2000 px on the long side. This cannot be undone, so keep the screen open until it finishes.
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} style={{ flex: 1, padding: 12 }}>Cancel</button>
                <button type="button" className="btn-primary" onClick={run} style={{ flex: 1, padding: 12 }}>Yes, convert</button>
              </div>
            </div>
          )}
        </div>
      )}

      {running && (
        <div className="macro-pill" style={{ ...pill, marginTop: 16, alignItems: "stretch", gap: 12, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Loader2 size={15} className="spin" /> Converting… {progress.handled} of {progress.total}</span><strong>{pct}%</strong>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: "rgb(var(--ink-rgb) / 0.08)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, var(--accent-gold), var(--accent-green))", transition: "width .4s ease" }} />
          </div>
          <button type="button" className="btn-secondary" onClick={() => { stopRef.current = true; }} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 10, fontSize: 12 }}>
            <Square size={13} /> Stop after this batch
          </button>
        </div>
      )}

      {totals && !running && (
        <div style={{ marginTop: 16 }}>
          <div className="macro-pill" style={{ gap: 10, marginBottom: 12 }}><CheckCircle2 size={18} color="var(--accent-green)" /> Cleanup finished</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            <div className="macro-pill" style={pill}><span className="plan-item-category" style={{ margin: 0 }}>Converted</span><strong style={{ fontSize: 24, color: "var(--accent-green)" }}>{totals.converted}</strong></div>
            <div className="macro-pill" style={pill}><span className="plan-item-category" style={{ margin: 0 }}>Space freed</span><strong style={{ fontSize: 24 }}>{fmtBytes(saved)}</strong><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{fmtBytes(totals.before)} → {fmtBytes(totals.after)}{totals.before ? ` (${Math.round((saved / totals.before) * 100)}% smaller)` : ""}</span></div>
            <div className="macro-pill" style={pill}><span className="plan-item-category" style={{ margin: 0 }}>Could not convert</span><strong style={{ fontSize: 24, color: totals.failed ? "var(--danger)" : undefined }}>{totals.failed}</strong>{totals.nogain > 0 && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{totals.nogain} left as-is (no saving)</span>}</div>
          </div>
          {errors.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}>
              <strong style={{ color: "var(--text-primary)" }}>Needs attention (originals were kept):</strong>
              <ul style={{ margin: "6px 0 0 18px", lineHeight: 1.6 }}>{errors.map((e, i) => <li key={i} style={{ wordBreak: "break-all" }}>{e.file} — {e.reason}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      <div className="section-header" style={{ margin: "28px 0 10px", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 14 }}>Recent cleanups</h2>
        <button type="button" onClick={loadHistory} aria-label="Refresh" style={{ background: "transparent", border: 0, color: "var(--text-secondary)", cursor: "pointer", padding: 6 }}><RefreshCw size={15} /></button>
      </div>
      {history.length === 0 ? <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>No cleanups yet.</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {history.map((h) => (
            <div key={h.runId} className="macro-pill" style={{ ...pill, gap: 4, padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 10, fontSize: 13 }}>
                <strong>{h.startedAt ? new Date(h.startedAt).toLocaleString() : "—"}</strong>
                <span style={{ color: "var(--accent-green)" }}>{fmtBytes((h.bytesBefore || 0) - (h.bytesAfter || 0))} freed</span>
              </div>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {h.converted ?? 0} converted{h.failed ? ` · ${h.failed} failed` : ""} · older than {h.days} days · by {h.adminCode || "admin"}{h.remaining ? ` · ${h.remaining} left (stopped early)` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
