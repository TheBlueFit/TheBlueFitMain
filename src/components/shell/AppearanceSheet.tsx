"use client";

import React from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { useTheme } from "@/components/shell/ThemeProvider";
import { THEMES, themeSwatch } from "@/lib/look";

/** Bottom sheet: the five themes. Picking one applies it live. Nothing else is customisable. */
export default function AppearanceSheet({ onClose }: { onClose: () => void }) {
  const { look, setThemePreset, resetLook, allowedThemes } = useTheme();
  const themes = THEMES.filter((t) => allowedThemes.indexOf(t.id) >= 0);
  const label: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--text-secondary)", marginBottom: 10, display: "block" };

  return (
    <div role="dialog" aria-modal="true" aria-label="Appearance" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 3000, background: "rgb(0 0 0 / 0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={(e) => e.stopPropagation()} className="bf-sheet"
        style={{ width: "100%", maxWidth: 520, maxHeight: "90dvh", overflowY: "auto", background: "var(--bg-elev, var(--bg-app))", border: "1px solid var(--border-subtle)", borderRadius: "22px 22px 0 0", padding: "18px 20px calc(22px + env(safe-area-inset-bottom))", boxShadow: "0 -12px 48px rgb(0 0 0 / 0.45)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <strong style={{ fontSize: 17 }}>Theme</strong>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: 0, color: "var(--text-secondary)", cursor: "pointer", padding: 6 }}><X size={20} /></button>
        </div>

        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.5 }}>
          Five looks, each one finished end to end. Your choice applies straight away.
        </p>

        <span style={label}>Choose a theme</span>
        <div style={{ display: "grid", gap: 10, marginBottom: 20 }}>
          {themes.map((t) => {
            const [a, b] = themeSwatch(t.id);
            const on = look.preset === t.id;
            return (
              <button key={t.id} type="button" onClick={() => setThemePreset(t.id)} aria-pressed={on}
                style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", padding: 12, borderRadius: 16, cursor: "pointer", fontFamily: "inherit", color: "var(--text-primary)",
                  border: on ? "1.5px solid var(--accent-gold)" : "1px solid var(--border-subtle)",
                  background: on ? `linear-gradient(120deg, ${a}1f, ${b}14)` : "transparent" }}>
                <span aria-hidden="true" style={{ width: 46, height: 46, borderRadius: 14, flex: "none", display: "grid", placeItems: "center",
                  background: `linear-gradient(135deg, ${a} 0 50%, ${b} 50% 100%)`, outline: on ? "2px solid var(--accent-gold)" : "none", outlineOffset: 2 }}>
                  <span style={{ width: 18, height: 18, borderRadius: "50%", background: "rgb(0 0 0 / 0.35)" }} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 700 }}>{t.label}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2, lineHeight: 1.4 }}>{t.blurb}</span>
                </span>
                {on && <Check size={18} color="var(--accent-gold)" />}
              </button>
            );
          })}
        </div>

        <button type="button" onClick={resetLook} className="btn-secondary" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "11px", fontSize: 12 }}>
          <RotateCcw size={14} /> Reset to the default theme
        </button>
      </div>
    </div>
  );
}
