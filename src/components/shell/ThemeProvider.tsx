"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Moon, Palette, Sun } from "lucide-react";
import {
  APPEARANCE_INIT_SCRIPT, applyLook, clampLook, DEFAULT_LOOK, Look, POLICY_KEY, readLookRaw, RESET_KEY, RolePolicy, saveLook, STYLES, THEME_KEY, LOOK_KEY,
} from "@/lib/look";
import { authSession, dashboardAPI } from "@/services/api";
import SceneBackground from "@/components/shell/SceneBackground";
import DepthRoot from "@/components/depth/DepthRoot";
import AppearanceSheet from "@/components/shell/AppearanceSheet";

export type Theme = "dark" | "light";
const META_COLOR: Record<Theme, string> = { dark: "#000000", light: "#F3F4F7" };

/** Runs before first paint (inlined in <head>) so there is never a flash of the wrong theme, colours or style. */
export const THEME_INIT_SCRIPT = APPEARANCE_INIT_SCRIPT;

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  look: Look;
  setLook: (patch: Partial<Look>) => void;
  resetLook: () => void;
  openAppearance: () => void;
  /** the admin's limits for this user's role (null = unrestricted: admins, or not signed in) */
  policy: RolePolicy | null;
  canCustomize: boolean;
  allowedThemes: Theme[];
}

const Ctx = createContext<ThemeCtx>({
  theme: "dark", setTheme: () => {}, toggle: () => {}, look: DEFAULT_LOOK, setLook: () => {}, resetLook: () => {}, openAppearance: () => {},
  policy: null, canCustomize: true, allowedThemes: ["dark", "light"],
});
export const useTheme = () => useContext(Ctx);

function readStorage(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function readStoredTheme(): Theme | null { const v = readStorage(THEME_KEY); return v === "light" || v === "dark" ? v : null; }
function readCachedPolicy(): RolePolicy | null {
  try { const c = JSON.parse(readStorage(POLICY_KEY) || "null"); return c && c.policy ? (c.policy as RolePolicy) : null; } catch { return null; }
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [rawTheme, setRawTheme] = useState<Theme | null>(null);
  const [raw, setRaw] = useState<{ look: Look; has: boolean }>({ look: DEFAULT_LOOK, has: false });
  const [policy, setPolicy] = useState<RolePolicy | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // first client render: read what the user chose and the last policy we saw for them
  useEffect(() => {
    setRawTheme(readStoredTheme());
    setRaw(readLookRaw());
    setPolicy(readCachedPolicy());
  }, []);

  // ---- admin policy: fetch for the signed-in role, keep a cache for the next first paint ----
  const refreshPolicy = useCallback(async () => {
    const session = authSession.get();
    if (!session?.token) { try { localStorage.removeItem(POLICY_KEY); } catch {} setPolicy(null); return; }
    if (session.role === "ADMIN") { try { localStorage.removeItem(POLICY_KEY); } catch {} setPolicy(null); return; }
    try {
      const res = await dashboardAPI.getMyAppearancePolicy();
      const pol = res.policy;
      try { if (pol) localStorage.setItem(POLICY_KEY, JSON.stringify({ role: res.role, policy: pol })); else localStorage.removeItem(POLICY_KEY); } catch {}
      if (pol) {
        // "reset everyone" from the admin console: drop this user's personal choices once
        const seen = Number(readStorage(RESET_KEY) || 0);
        if (pol.resetCounter !== seen) {
          if (seen !== 0 || readStorage(LOOK_KEY)) { try { localStorage.removeItem(LOOK_KEY); localStorage.removeItem(THEME_KEY); } catch {} setRawTheme(null); setRaw(readLookRaw()); }
          try { localStorage.setItem(RESET_KEY, String(pol.resetCounter)); } catch {}
        }
      }
      setPolicy(pol);
    } catch { /* offline: keep the cached policy */ }
  }, []);

  useEffect(() => {
    refreshPolicy();
    let last = Date.now();
    const onVisible = () => { if (document.visibilityState === "visible" && Date.now() - last > 60_000) { last = Date.now(); refreshPolicy(); } };
    window.addEventListener("bluefit:auth-change", refreshPolicy);
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(refreshPolicy, 10 * 60_000);
    return () => { window.removeEventListener("bluefit:auth-change", refreshPolicy); document.removeEventListener("visibilitychange", onVisible); window.clearInterval(id); };
  }, [refreshPolicy]);

  // ---- effective look = what the user picked, pulled back inside the admin's limits ----
  const effective = useMemo(
    () => clampLook(raw.look, rawTheme ?? "dark", policy, raw.has, rawTheme !== null),
    [raw, rawTheme, policy],
  );
  const theme = effective.theme;
  const look = effective.look;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_COLOR[theme]);
    applyLook(look, theme);
  }, [theme, look]);

  const canCustomize = policy ? policy.allowCustomize : true;
  const allowedThemes: Theme[] = !policy ? ["dark", "light"] : !policy.allowCustomize ? [theme] : policy.themes;

  const setTheme = useCallback((next: Theme) => {
    if (policy && (!policy.allowCustomize || !policy.themes.includes(next))) return;
    setRawTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch {}
  }, [policy]);

  const toggle = useCallback(() => setTheme(theme === "light" ? "dark" : "light"), [setTheme, theme]);

  const setLook = useCallback((patch: Partial<Look>) => {
    if (policy && !policy.allowCustomize) return;
    setRaw((prev) => {
      // choosing a style also switches to the colours it is designed with (they can still be changed afterwards)
      let suggested = patch.style && patch.palette === undefined ? STYLES.find((x) => x.id === patch.style)?.palette : undefined;
      if (suggested && policy && !policy.palettes.includes(suggested)) suggested = undefined;
      const next = { ...prev.look, ...patch, ...(suggested ? { palette: suggested } : {}) };
      saveLook(next);
      return { look: next, has: true };
    });
  }, [policy]);

  const resetLook = useCallback(() => {
    try { localStorage.removeItem(LOOK_KEY); localStorage.removeItem(THEME_KEY); } catch {}
    setRawTheme(null);
    setRaw(readLookRaw());
  }, []);

  const openAppearance = useCallback(() => setSheetOpen(true), []);
  useEffect(() => { if (!canCustomize) setSheetOpen(false); }, [canCustomize]);

  return (
    <Ctx.Provider value={{ theme, setTheme, toggle, look, setLook, resetLook, openAppearance, policy, canCustomize, allowedThemes }}>
      <SceneBackground />
      <DepthRoot />
      {children}
      {sheetOpen && canCustomize && <AppearanceSheet onClose={() => setSheetOpen(false)} />}
    </Ctx.Provider>
  );
}

/** Light / dark switch. `compact` renders just the icon (phone top bar, login page). Hidden when the admin allows only one theme. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggle, allowedThemes, canCustomize } = useTheme();
  if (!canCustomize || allowedThemes.length < 2) return null;
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      className={`theme-toggle${compact ? " icon-only" : ""}`}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      {!compact && (
        <>
          <span>{theme === "dark" ? "Dark" : "Light"} theme</span>
          <span className="track" aria-hidden="true" />
        </>
      )}
    </button>
  );
}

/** Opens the Appearance sheet (palette, vibrancy, motion). Hidden when the admin switched customisation off. */
export function AppearanceButton({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  const { openAppearance, canCustomize } = useTheme();
  if (!canCustomize) return null;
  return (
    <button type="button" onClick={openAppearance} className={`theme-toggle${compact ? " icon-only" : ""} ${className}`} aria-label="Appearance: colours and animation" title="Appearance">
      <Palette size={17} />
      {!compact && <span>Appearance</span>}
    </button>
  );
}
