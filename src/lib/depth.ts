// Depth (3D) capability tiers.
//
//   off  - no 3D at all: Animations switched off, or the phone asks for reduced motion
//   lite - press-to-tilt only (no sensors, no continuous work): low-end phones, Data Saver on
//   full - press-to-tilt + gyroscope parallax + glare: everything else
//
// The tier lands on <html data-depth="..."> so CSS can opt in per tier, and in a tiny store
// so hooks can read it without React context. Override for testing with ?depth=off|lite|full.

export type DepthTier = "off" | "lite" | "full";

type NavExtras = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };

export function detectDepthTier(motion: "on" | "off"): DepthTier {
  if (typeof window === "undefined") return "off";
  try {
    const forced = new URLSearchParams(window.location.search).get("depth");
    if (forced === "off" || forced === "lite" || forced === "full") return forced;
  } catch {}
  if (motion === "off") return "off";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "off";
  const nav = navigator as NavExtras;
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? 4;
  if (nav.connection?.saveData) return "lite";
  if (cores <= 4 || memory < 4) return "lite";
  return "full";
}

let current: DepthTier | null = null; // null until the first set(), so "off" is written too
const listeners = new Set<() => void>();

export const depthStore = {
  get: (): DepthTier => current ?? "off",
  set(tier: DepthTier) {
    if (tier === current) return;
    current = tier;
    if (typeof document !== "undefined") document.documentElement.setAttribute("data-depth", tier);
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};
