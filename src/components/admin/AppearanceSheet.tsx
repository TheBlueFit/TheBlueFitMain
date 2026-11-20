"use client";

import React from "react";
import { Check, Moon, RotateCcw, Sun, X } from "lucide-react";
import { useTheme } from "@/components/shell/ThemeProvider";
import { BLURS, clampVibrancy, computeLookVars, SCENES, THEMES } from "@/lib/look";

const rgb = (c: number[]) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/** Bottom sheet: light/dark, theme (style + colour in one), vibrancy and animations. Changes apply live. */
export default function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const { theme, setTheme, look, setLook, resetLook, policy, allowedThemes } = useTheme();

  const themes   = THEMES.filter((x) => !policy || policy.themes.includes(x.id));
  const scenes   = SCENES.filter((x) => !policy || policy.scenes.includes(x.id));
  const canVibrancy = !policy || policy.allowVibrancy;
  const canMotion   = !policy || policy.allowMotionToggle;
  const canBlur     = !policy || policy.allowBlur !== false;

  /** Two-colour swatch for a theme — primary + secondary accent */
  const swatch = (themeId: (typeof THEMES)[number]["id"]) => {
    const def  = THEMES.find((t) => t.id === themeId)!;
    const vars = computeLookVars({ ...look, theme: themeId }, theme);
    if (vars) return [`rgb(${vars["--gold-rgb"]})`, `rgb(${vars["--green-rgb"]})`];
    const [a, b] = theme === "dark" ? def.dark : def.light;
    return [rgb(a), rgb(b)];
  };

  const label: React.CSSProperties = {
    fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em",
    color: "var(--text-secondary)", marginBottom: 10, display: "block",
  };
  const seg = (on: boolean): React.CSSProperties => ({
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
    gap: 8, padding: "11px 12px", borderRadius: 12, fontSize: 13, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit", border: "1px solid var(--border-subtle)",
    background: on ? "var(--text-primary)" : "transparent",
    color: on ? "var(--bg-app)" : "var(--text-primary)",
  });

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Appearance" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgb(0 0 0 / 0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()} className="bf-sheet"
        style={{ width: "100%", maxWidth: 520, maxHeight: "90dvh", overflowY: "auto", background: "var(--bg-elev, var(--bg-app))", border: "1px solid var(--border-subtle)", borderRadius: "22px 22px 0 0", padding: "18px 20px calc(22px + env(safe-area-inset-bottom))", boxShadow: "0 -12px 48px rgb(0 0 0 / 0.45)" }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <strong style={{ fontSize: 17 }}>Appearance</strong>
          <div style={{ display: "flex", gap: 4 }}>
            {policy?.allowCustomize !== false && (
              <button type="button" onClick={resetLook} aria-label="Reset to defaults"
                style={{ background: "transparent", border: 0, color: "var(--text-secondary)", cursor: "pointer", padding: 6 }}>
                <RotateCcw size={18} />
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close"
              style={{ background: "transparent", border: 0, color: "var(--text-secondary)", cursor: "pointer", padding: 6 }}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Live preview */}
        <div style={{ padding: 16, borderRadius: 16, marginBottom: 20, border: "1px solid rgb(var(--gold-rgb) / 0.25)", background: "linear-gradient(135deg, rgb(var(--gold-rgb) / 0.10), rgb(var(--green-rgb) / 0.08))" }}>
          <div className="animated-gradient-text" style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>Welcome back</div>
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <span style={{ padding: "5px 11px", borderRadius: 999, fontSize: 11, color: "var(--accent-gold)", background: "rgb(var(--gold-rgb) / 0.14)", border: "1px solid rgb(var(--gold-rgb) / 0.35)" }}>Primary</span>
            <span style={{ padding: "5px 11px", borderRadius: 999, fontSize: 11, color: "var(--accent-green)", background: "rgb(var(--green-rgb) / 0.14)", border: "1px solid rgb(var(--green-rgb) / 0.35)" }}>Secondary</span>
            <span style={{ padding: "5px 11px", borderRadius: 999, fontSize: 11, color: "var(--blue)", background: "rgb(var(--blue-rgb) / 0.14)", border: "1px solid rgb(var(--blue-rgb) / 0.35)" }}>Info</span>
          </div>
        </div>

        {/* Dark / Light */}
        {allowedThemes.length > 1 && (
          <>
            <span style={label}>Theme</span>
            <div style={{ display: "flex", gap: 10, marginBottom: 22 }}>
              <button type="button" style={seg(theme === "dark")}  onClick={() => setTheme("dark")}><Moon size={15} /> Dark</button>
              <button type="button" style={seg(theme === "light")} onClick={() => setTheme("light")}><Sun size={15} /> Light</button>
            </div>
          </>
        )}

        {/* Theme picker — replaces separate Style + Colour sections */}
        {themes.length > 1 && (
          <>
            <span style={label}>Look</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 }}>
              {themes.map((t) => {
                const on = look.theme === t.id;
                const [colorA, colorB] = swatch(t.id);
                return (
                  <button
                    key={t.id} type="button" onClick={() => setLook({ theme: t.id })} aria-pressed={on}
                    style={{ textAlign: "left", padding: "12px 14px", borderRadius: "var(--radius-md, 14px)", cursor: "pointer", fontFamily: "inherit", color: "var(--text-primary)", border: on ? "1.5px solid var(--accent-gold)" : "1px solid var(--border-subtle)", background: on ? "rgb(var(--gold-rgb) / 0.12)" : "transparent" }}
                  >
                    {/* Two-tone swatch dot */}
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ width: 28, height: 28, borderRadius: "50%", background: `linear-gradient(135deg, ${colorA} 0 50%, ${colorB} 50% 100%)`, border: "1px solid rgb(255 255 255 / 0.12)", flex: "none" }} />
                      {on && <Check size={15} color="var(--accent-gold)" />}
                    </span>
                    <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{t.blurb}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Vibrancy */}
        {canVibrancy && (
          <>
            <span style={{ ...label, display: "flex", justifyContent: "space-between" }}>
              <span>Vibrancy</span>
              <span style={{ textTransform: "none", letterSpacing: 0 }}>
                {look.vibrancy >= 100 ? "Full colour" : look.vibrancy <= 55 ? "Very soft" : "Softened"}
              </span>
            </span>
            <input
              type="range" min={40} max={100} step={5} value={look.vibrancy} aria-label="Colour vibrancy"
              onChange={(e) => setLook({ vibrancy: clampVibrancy(Number(e.target.value)) })}
              style={{ width: "100%", accentColor: "var(--accent-gold)", marginBottom: 4 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-secondary)", marginBottom: 22 }}>
              <span>Muted</span><span>Vivid</span>
            </div>
          </>
        )}

        {/* Background scenery */}
        {scenes.length > 1 && (
          <>
            <span style={label}>Background scenery</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
              {scenes.map((sc) => {
                const on = look.scene === sc.id;
                return (
                  <button key={sc.id} type="button" onClick={() => setLook({ scene: sc.id })} aria-pressed={on}
                    style={{ padding: "8px 13px", borderRadius: 999, fontSize: 12, cursor: "pointer", fontFamily: "inherit", border: on ? "1px solid rgb(var(--gold-rgb) / 0.6)" : "1px solid var(--border-subtle)", background: on ? "rgb(var(--gold-rgb) / 0.15)" : "transparent", color: on ? "var(--accent-gold)" : "var(--text-primary)" }}>
                    {sc.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 22 }}>
              Auto follows your phone's clock: stars at night, a breeze and birds in the morning, sun and butterflies in the afternoon, fireflies at sunset.
            </div>
          </>
        )}

        {/* Menu background blur */}
        {canBlur && (
          <>
            <span style={label}>Menu background</span>
            <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
              {BLURS.map((b) => {
                const on = (look.blur ?? "soft") === b.id;
                return (
                  <button key={b.id} type="button" onClick={() => setLook({ blur: b.id })} aria-pressed={on}
                    style={{ flex: 1, padding: "9px 12px", borderRadius: 10, fontSize: 12, cursor: "pointer", fontFamily: "inherit", border: on ? "1px solid rgb(var(--gold-rgb) / 0.6)" : "1px solid var(--border-subtle)", background: on ? "rgb(var(--gold-rgb) / 0.15)" : "transparent", color: on ? "var(--accent-gold)" : "var(--text-primary)" }}>
                    {b.label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* Motion */}
        {canMotion && (
          <>
            <span style={label}>Animations</span>
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <button type="button" style={seg(look.motion === "on")}  onClick={() => setLook({ motion: "on" })}>On</button>
              <button type="button" style={seg(look.motion === "off")} onClick={() => setLook({ motion: "off" })}>Off</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
