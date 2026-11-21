"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { AppearancePolicyAll, dashboardAPI } from "@/services/api";
import { RolePolicy, THEMES, ThemeId, themeSwatch } from "@/lib/look";

type RoleKey = "CLIENT" | "COACH";
const ROLE_LABEL: Record<RoleKey, string> = { CLIENT: "Clients", COACH: "Coaches" };

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", borderRadius: 14, border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontFamily: "inherit", fontSize: 14, textAlign: "left" }}>
      <span>{label}{hint && <span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{hint}</span>}</span>
      <span style={{ width: 44, height: 26, borderRadius: 999, position: "relative", flex: "none", background: checked ? "var(--accent-gold)" : "rgb(var(--ink-rgb) / 0.18)", transition: "background .2s" }}>
        <span style={{ position: "absolute", top: 3, left: checked ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left .2s", boxShadow: "0 1px 3px rgb(0 0 0 / 0.4)" }} />
      </span>
    </button>
  );
}

/** Admin: the five themes only. Pick which ones each role may use, and the one they start on. */
export default function AppearancePolicy() {
  const [data, setData] = useState<AppearancePolicyAll | null>(null);
  const [role, setRole] = useState<RoleKey>("CLIENT");
  const [draft, setDraft] = useState<Record<RoleKey, RolePolicy> | null>(null);
  // Brand-wide, not per role: the mascot appears everywhere or nowhere.
  const [mascot, setMascot] = useState(true);
  const [resetNow, setResetNow] = useState<Record<RoleKey, boolean>>({ CLIENT: false, COACH: false });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    dashboardAPI.getAppearancePolicy()
      .then((d) => { setData(d); setDraft(JSON.parse(JSON.stringify(d.roles))); setMascot(d.mascot !== false); })
      .catch((e) => setMsg({ ok: false, text: e.message || "Could not load settings." }));
  }, []);

  const p = draft?.[role];
  const dirty = useMemo(() => !!data && !!draft && (JSON.stringify(data.roles) !== JSON.stringify(draft) || resetNow.CLIENT || resetNow.COACH || data.mascot !== mascot), [data, draft, resetNow, mascot]);

  const patch = (changes: Partial<RolePolicy>) => { setMsg(null); setDraft((d) => d && ({ ...d, [role]: { ...d[role], ...changes } })); };

  /** add / remove a theme from the allowed list; the last one can't be removed, and the default is repaired */
  const toggleTheme = (id: ThemeId) => {
    if (!p) return;
    const has = p.themes.indexOf(id) >= 0;
    const next = has ? p.themes.filter((x) => x !== id) : [...p.themes, id];
    if (!next.length) return;
    const defaultTheme = next.indexOf(p.defaultTheme) >= 0 ? p.defaultTheme : next[0];
    patch({ themes: THEMES.filter((t) => next.indexOf(t.id) >= 0).map((t) => t.id), defaultTheme });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setMsg(null);
    try {
      const roles: any = {};
      (["CLIENT", "COACH"] as RoleKey[]).forEach((r) => { roles[r] = { ...draft[r], resetNow: resetNow[r] }; });
      const saved = await dashboardAPI.saveAppearancePolicy(roles, mascot);
      setData(saved); setDraft(JSON.parse(JSON.stringify(saved.roles))); setMascot(saved.mascot !== false);
      setResetNow({ CLIENT: false, COACH: false });
      setMsg({ ok: true, text: "Saved. People get the new look on their next app refresh (within minutes, or on next open)." });
    } catch (e: any) { setMsg({ ok: false, text: e.message || "Could not save." }); }
    finally { setSaving(false); }
  };

  if (!draft || !p) return <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>{msg ? <div className="error-banner">{msg.text}</div> : "Loading settings…"}</div>;
  const off = !p.allowCustomize;

  return (
    <div className="fade-in">
      <div className="section-header" style={{ marginBottom: 8 }}><h2 style={{ fontSize: 16 }}>Appearance</h2></div>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 16 }}>
        Five themes, nothing else. Choose which ones clients and coaches may use, and the one they start with. Admins are never restricted. Changes apply without an app update.
      </p>

      <div className="macro-pill" style={{ flexDirection: "column", alignItems: "stretch", gap: 16, padding: 16, marginBottom: 16 }}>
        <Switch
          label="Show the mascot"
          hint="The bull-skull coach on the sign-in screen, in the app header and in empty conversations. Off = text and icons only, for everyone."
          checked={mascot}
          onChange={(v) => { setMsg(null); setMascot(v); }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["CLIENT", "COACH"] as RoleKey[]).map((r) => (
          <button key={r} type="button" onClick={() => setRole(r)} className={role === r ? "btn-primary" : "btn-secondary"} style={{ flex: 1, padding: 12 }}>{ROLE_LABEL[r]}</button>
        ))}
      </div>

      <div className="macro-pill" style={{ flexDirection: "column", alignItems: "stretch", gap: 16, padding: 16 }}>
        <Switch label={`Let ${ROLE_LABEL[role].toLowerCase()} choose their theme`} hint="Off = everyone gets the default theme and the Appearance menu is hidden" checked={p.allowCustomize} onChange={(v) => patch({ allowCustomize: v })} />

        <div style={{ opacity: off ? 0.45 : 1, pointerEvents: off ? "none" : "auto" }}>
          <span className="plan-item-category" style={{ display: "block", marginBottom: 10 }}>Themes allowed</span>
          <div style={{ display: "grid", gap: 10 }}>
            {THEMES.map((t) => {
              const [a, b] = themeSwatch(t.id);
              const on = p.themes.indexOf(t.id) >= 0;
              const isDefault = p.defaultTheme === t.id;
              return (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, borderRadius: 14, border: on ? "1px solid rgb(var(--gold-rgb) / 0.5)" : "1px solid var(--border-subtle)", background: on ? `linear-gradient(120deg, ${a}17, ${b}0f)` : "transparent" }}>
                  <span aria-hidden="true" style={{ width: 38, height: 38, borderRadius: 12, flex: "none", background: `linear-gradient(135deg, ${a} 0 50%, ${b} 50% 100%)` }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{t.label}</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginTop: 1, lineHeight: 1.4 }}>{t.blurb}</span>
                  </span>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: isDefault ? "var(--accent-gold)" : "var(--text-secondary)", cursor: on ? "pointer" : "default" }}>
                    <input type="radio" name={`default-${role}`} checked={isDefault} disabled={!on}
                      onChange={() => patch({ defaultTheme: t.id })} style={{ margin: 0, accentColor: "var(--accent-gold)" }} />
                    Default
                  </label>
                  <button type="button" onClick={() => toggleTheme(t.id)} aria-pressed={on} aria-label={`${on ? "Remove" : "Allow"} ${t.label}`}
                    style={{ width: 28, height: 28, borderRadius: 9, flex: "none", display: "grid", placeItems: "center", cursor: "pointer",
                      border: on ? "1px solid rgb(var(--gold-rgb) / 0.6)" : "1px solid var(--border-subtle)",
                      background: on ? "rgb(var(--gold-rgb) / 0.16)" : "transparent", color: on ? "var(--accent-gold)" : "var(--text-secondary)" }}>
                    <Check size={14} style={{ opacity: on ? 1 : 0.25 }} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, cursor: "pointer", lineHeight: 1.45 }}>
          <input type="checkbox" checked={resetNow[role]} onChange={(e) => setResetNow((r) => ({ ...r, [role]: e.target.checked }))} style={{ width: 18, height: 18, accentColor: "var(--accent-gold)", marginTop: 1, flex: "none" }} />
          <span>Reset everyone&apos;s theme to the default when I save<span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)" }}>Otherwise people keep their theme, as long as it is still allowed.</span></span>
        </label>
      </div>

      {msg && <div className={msg.ok ? undefined : "error-banner"} style={msg.ok ? { color: "var(--accent-green)", fontSize: 13, marginTop: 14 } : { marginTop: 14 }}>{msg.text}</div>}

      <button type="button" className="btn-primary" onClick={save} disabled={saving || !dirty} style={{ marginTop: 16, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, opacity: dirty ? 1 : 0.55 }}>
        {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} {saving ? "Saving…" : "Save appearance"}
      </button>
      {data?.updatedAt && <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 10, textAlign: "center" }}>Last saved {new Date(data.updatedAt).toLocaleString()}{data.updatedBy ? ` by ${data.updatedBy}` : ""}</p>}
    </div>
  );
}
