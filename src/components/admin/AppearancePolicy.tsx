"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Save } from "lucide-react";
import { AppearancePolicyAll, dashboardAPI } from "@/services/api";
import { BLURS, PALETTES, RolePolicy, SCENES, STYLES } from "@/lib/look";

type RoleKey = "CLIENT" | "COACH";
const ROLE_LABEL: Record<RoleKey, string> = { CLIENT: "Clients", COACH: "Coaches" };
const THEMES: { id: "dark" | "light"; label: string }[] = [{ id: "dark", label: "Dark" }, { id: "light", label: "Light" }];
const rgb = (c: number[]) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
const field: React.CSSProperties = { background: "rgb(var(--well-rgb) / 0.4)", border: "1px solid var(--border-subtle)", borderRadius: 10, color: "var(--text-primary)", padding: "10px 12px", fontSize: 16, outline: "none", width: "100%", boxSizing: "border-box" };
const heading: React.CSSProperties = { margin: 0, display: "block", marginBottom: 8 };

function Chip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 999, fontSize: 12, cursor: disabled ? "default" : "pointer", fontFamily: "inherit",
        border: on ? "1px solid rgb(var(--gold-rgb) / 0.6)" : "1px solid var(--border-subtle)", background: on ? "rgb(var(--gold-rgb) / 0.15)" : "transparent", color: on ? "var(--accent-gold)" : "var(--text-primary)", opacity: disabled ? 0.5 : 1 }}>
      {on && <Check size={13} />}{children}
    </button>
  );
}

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

export default function AppearancePolicy() {
  const [data, setData] = useState<AppearancePolicyAll | null>(null);
  const [role, setRole] = useState<RoleKey>("CLIENT");
  const [draft, setDraft] = useState<Record<RoleKey, RolePolicy> | null>(null);
  const [resetNow, setResetNow] = useState<Record<RoleKey, boolean>>({ CLIENT: false, COACH: false });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    dashboardAPI.getAppearancePolicy().then((d) => { setData(d); setDraft(JSON.parse(JSON.stringify(d.roles))); }).catch((e) => setMsg({ ok: false, text: e.message || "Could not load settings." }));
  }, []);

  const p = draft?.[role];
  const dirty = useMemo(() => !!data && !!draft && (JSON.stringify(data.roles) !== JSON.stringify(draft) || resetNow.CLIENT || resetNow.COACH), [data, draft, resetNow]);

  const patch = (changes: Partial<RolePolicy>) => { setMsg(null); setDraft((d) => d && ({ ...d, [role]: { ...d[role], ...changes } })); };

  /** toggle an option in a list; keeps at least one, and repairs the default if it was just removed */
  const toggleIn = <K extends "styles" | "palettes" | "scenes" | "themes">(key: K, id: string, defKey: "style" | "palette" | "scene" | "theme") => {
    if (!p) return;
    const list = p[key] as string[];
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    if (!next.length) return;
    const defaults = { ...p.defaults };
    if (!next.includes(defaults[defKey] as string)) (defaults as any)[defKey] = next[0];
    patch({ [key]: next, defaults } as any);
  };
  const setDefault = (k: keyof RolePolicy["defaults"], v: any) => p && patch({ defaults: { ...p.defaults, [k]: v } });

  const save = async () => {
    if (!draft) return;
    setSaving(true); setMsg(null);
    try {
      const roles: any = {};
      (["CLIENT", "COACH"] as RoleKey[]).forEach((r) => { roles[r] = { ...draft[r], resetNow: resetNow[r] }; });
      const saved = await dashboardAPI.saveAppearancePolicy(roles);
      setData(saved); setDraft(JSON.parse(JSON.stringify(saved.roles))); setResetNow({ CLIENT: false, COACH: false });
      setMsg({ ok: true, text: "Saved. Users get the new settings the next time their app refreshes (within minutes, or on next open)." });
    } catch (e: any) { setMsg({ ok: false, text: e.message || "Could not save." }); }
    finally { setSaving(false); }
  };

  if (!draft || !p) return <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>{msg ? <div className="error-banner">{msg.text}</div> : "Loading settings…"}</div>;
  const off = !p.allowCustomize;

  return (
    <div className="fade-in">
      <div className="section-header" style={{ marginBottom: 8 }}><h2 style={{ fontSize: 16 }}>Appearance controls</h2></div>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 16 }}>
        Choose which looks clients and coaches may use, and what they start with. Admins are never restricted. Changes apply without any app update.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["CLIENT", "COACH"] as RoleKey[]).map((r) => (
          <button key={r} type="button" onClick={() => setRole(r)} className={role === r ? "btn-primary" : "btn-secondary"} style={{ flex: 1, padding: 12 }}>{ROLE_LABEL[r]}</button>
        ))}
      </div>

      <div className="macro-pill" style={{ flexDirection: "column", alignItems: "stretch", gap: 18, padding: 16 }}>
        <Switch label={`Let ${ROLE_LABEL[role].toLowerCase()} customise the app`} hint="Off = everyone sees the defaults below and the Appearance menu is hidden" checked={p.allowCustomize} onChange={(v) => patch({ allowCustomize: v })} />

        <div style={{ opacity: off ? 0.45 : 1, pointerEvents: off ? "none" : "auto", display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <span className="plan-item-category" style={heading}>Styles allowed</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{STYLES.map((s) => <Chip key={s.id} on={p.styles.includes(s.id)} onClick={() => toggleIn("styles", s.id, "style")}>{s.label}</Chip>)}</div>
          </div>
          <div>
            <span className="plan-item-category" style={heading}>Colours allowed</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {PALETTES.map((c) => (
                <Chip key={c.id} on={p.palettes.includes(c.id)} onClick={() => toggleIn("palettes", c.id, "palette")}>
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: `linear-gradient(135deg, ${rgb(c.dark[0])} 0 50%, ${rgb(c.dark[1])} 50%)`, flex: "none" }} />{c.label}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <span className="plan-item-category" style={heading}>Background scenery allowed</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{SCENES.map((s) => <Chip key={s.id} on={p.scenes.includes(s.id)} onClick={() => toggleIn("scenes", s.id, "scene")}>{s.label}</Chip>)}</div>
          </div>
          <div>
            <span className="plan-item-category" style={heading}>Themes allowed</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{THEMES.map((t) => <Chip key={t.id} on={p.themes.includes(t.id)} onClick={() => toggleIn("themes", t.id, "theme")}>{t.label}</Chip>)}</div>
          </div>
          <Switch label="Allow the vibrancy slider" checked={p.allowVibrancy} onChange={(v) => patch({ allowVibrancy: v })} />
          <Switch label="Allow changing the menu background blur" hint="The blur behind the open navigation menu" checked={p.allowBlur !== false} onChange={(v) => patch({ allowBlur: v })} />
          <Switch label="Allow turning animations on / off" checked={p.allowMotionToggle} onChange={(v) => patch({ allowMotionToggle: v })} />
        </div>

        <div>
          <span className="plan-item-category" style={heading}>Default look ({ROLE_LABEL[role].toLowerCase()} start with this)</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <label><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Style</span>
              <select value={p.defaults.style} onChange={(e) => setDefault("style", e.target.value)} style={field}>{STYLES.filter((s) => p.styles.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
            <label><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Colour</span>
              <select value={p.defaults.palette} onChange={(e) => setDefault("palette", e.target.value)} style={field}>{PALETTES.filter((c) => p.palettes.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
            <label><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Scenery</span>
              <select value={p.defaults.scene} onChange={(e) => setDefault("scene", e.target.value)} style={field}>{SCENES.filter((s) => p.scenes.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
            <label><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Theme</span>
              <select value={p.defaults.theme} onChange={(e) => setDefault("theme", e.target.value)} style={field}>{THEMES.filter((t) => p.themes.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
            <label><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Animations</span>
              <select value={p.defaults.motion} onChange={(e) => setDefault("motion", e.target.value)} style={field}><option value="on">On</option><option value="off">Off</option></select></label>
            <label><span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Menu background</span>
              <select value={p.defaults.blur ?? "soft"} onChange={(e) => setDefault("blur", e.target.value)} style={field}>{BLURS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></label>
          </div>
          <label style={{ display: "block", marginTop: 12 }}>
            <span style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", justifyContent: "space-between" }}><span>Vibrancy</span><span>{p.defaults.vibrancy}%</span></span>
            <input type="range" min={40} max={100} step={5} value={p.defaults.vibrancy} onChange={(e) => setDefault("vibrancy", Number(e.target.value))} style={{ width: "100%", accentColor: "var(--accent-gold)" }} />
          </label>
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, cursor: "pointer", lineHeight: 1.45 }}>
          <input type="checkbox" checked={resetNow[role]} onChange={(e) => setResetNow((r) => ({ ...r, [role]: e.target.checked }))} style={{ width: 18, height: 18, accentColor: "var(--accent-gold)", marginTop: 1, flex: "none" }} />
          <span>Reset everyone&apos;s personal choices to these defaults when I save<span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)" }}>Otherwise people keep what they picked, as long as it is still allowed.</span></span>
        </label>
      </div>

      {msg && <div className={msg.ok ? undefined : "error-banner"} style={msg.ok ? { color: "var(--accent-green)", fontSize: 13, marginTop: 14 } : { marginTop: 14 }}>{msg.text}</div>}

      <button type="button" className="btn-primary" onClick={save} disabled={saving || !dirty} style={{ marginTop: 16, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, opacity: dirty ? 1 : 0.55 }}>
        {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} {saving ? "Saving…" : "Save for clients and coaches"}
      </button>
      {data?.updatedAt && <p style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 10, textAlign: "center" }}>Last saved {new Date(data.updatedAt).toLocaleString()}{data.updatedBy ? ` by ${data.updatedBy}` : ""}</p>}
    </div>
  );
}
