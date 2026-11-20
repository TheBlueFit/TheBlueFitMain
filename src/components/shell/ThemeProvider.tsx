"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Palette } from "lucide-react";
import {
  APPEARANCE_INIT_SCRIPT, applyLook, clampLook, DEFAULT_LOOK, isThemeId, Look, POLICY_KEY, presetLook, readLookRaw,
  RESET_KEY, RolePolicy, saveLook, themeOf, ThemeId, THEMES,
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
  look: Look;
  /** pick one of the five themes */
  setThemePreset: (id: ThemeId) => void;
  resetLook: () => void;
  openAppearance: () => void;
  /** the admin's limits for this user's role (null = unrestricted: admins, or not signed in) */
  policy: RolePolicy | null;
  canCustomize: boolean;
  allowedThemes: ThemeId[];
}

const Ctx = createContext<ThemeCtx>({
  theme: "dark", look: DEFAULT_LOOK, setThemePreset: () => {}, resetLook: () => {}, openAppearance: () => {},
  policy: null, canCustomize: true, allowedThemes: THEMES.map((t) => t.id),
});
export const useTheme = () => useContext(Ctx);

function readStorage(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function readCachedPolicy(): RolePolicy | null {
  try {
    const c = JSON.parse(readStorage(POLICY_KEY) || "null");
    const pol = c && c.policy ? (c.policy as RolePolicy) : null;
    // a policy saved by an older build has no theme list: ignore it rather than trusting it
    return pol && Array.isArray(pol.themes) && pol.themes.length ? pol : null;
  } catch { return null; }
}

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [raw, setRaw] = useState<{ look: Look; has: boolean }>({ look: DEFAULT_LOOK, has: false });
  const [policy, setPolicy] = useState<RolePolicy | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // first client render: read the saved theme and the last policy we saw for this person
  useEffect(() => {
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
        // "reset everyone" from the admin console: drop this user's personal choice once
        const seen = Number(readStorage(RESET_KEY) || 0);
        if (pol.resetCounter !== seen) {
          if (seen !== 0 || readStorage("bluefit_look")) { try { localStorage.removeItem("bluefit_look"); } catch {} setRaw(readLookRaw()); }
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

  // ---- effective look = the person's theme, pulled back inside the admin's five ----
  const look = useMemo(() => clampLook(raw.look, policy, raw.has), [raw, policy]);
  const theme = themeOf(look);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_COLOR[theme]);
    applyLook(look, theme);
  }, [theme, look]);

  const canCustomize = policy ? policy.allowCustomize : true;
  const allowedThemes: ThemeId[] = !policy ? THEMES.map((t) => t.id) : policy.allowCustomize ? policy.themes : [policy.defaultTheme];

  const setThemePreset = useCallback((id: ThemeId) => {
    if (policy && (!policy.allowCustomize || policy.themes.indexOf(id) < 0)) return;
    if (!isThemeId(id)) return;
    setRaw((prev) => {
      const next: Look = { ...presetLook(id), motion: prev.look.motion };
      saveLook(next);
      return { look: next, has: true };
    });
  }, [policy]);

  const resetLook = useCallback(() => {
    try { localStorage.removeItem("bluefit_look"); } catch {}
    setRaw(readLookRaw());
  }, []);

  const openAppearance = useCallback(() => setSheetOpen(true), []);
  useEffect(() => { if (!canCustomize) setSheetOpen(false); }, [canCustomize]);

  return (
    <Ctx.Provider value={{ theme, look, setThemePreset, resetLook, openAppearance, policy, canCustomize, allowedThemes }}>
      <SceneBackground />
      <DepthRoot />
      {children}
      {sheetOpen && canCustomize && <AppearanceSheet onClose={() => setSheetOpen(false)} />}
    </Ctx.Provider>
  );
}

/** Appearance: opens the five-theme sheet. Hidden when the admin switched customisation off. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { openAppearance, canCustomize } = useTheme();
  if (!canCustomize) return null;
  return (
    <button
      type="button"
      onClick={openAppearance}
      className={`theme-toggle${compact ? " icon-only" : ""}`}
      aria-label="Appearance: choose a theme"
      title="Appearance"
    >
      <Palette size={17} />
      {!compact && <span>Appearance</span>}
    </button>
  );
}

/** Opens the Appearance sheet. Same control as ThemeToggle, kept as a separate name for existing pages. */
export function AppearanceButton({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  const { openAppearance, canCustomize } = useTheme();
  if (!canCustomize) return null;
  return (
    <button type="button" onClick={openAppearance} className={`theme-toggle${compact ? " icon-only" : ""} ${className}`} aria-label="Appearance: choose a theme" title="Appearance">
      <Palette size={17} />
      {!compact && <span>Appearance</span>}
    </button>
  );
}
