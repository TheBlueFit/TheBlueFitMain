// Depth (3D) layer: capability tiers + one global engine that gives every card in the app a physical feel.
//
// What the user picks (Appearance > Depth, limited by the admin policy):
//   off        no 3D
//   subtle     cards tilt under your finger (and follow the mouse on desktop)
//   immersive  subtle + cards follow the phone's movement (gyroscope) + screens rise into place in 3D as you scroll
//
// What the device allows (worked out here, never asked):
//   off   Animations switched off, reduce-motion on, or the user picked Flat
//   lite  4 cores or fewer, under 4 GB RAM, or Data Saver: press-tilt only, no gyroscope
//   full  everything else
//
// <html data-depth="off|lite|full"> and <html data-depth-mode="off|subtle|immersive"> drive the CSS in globals.css.
// Only transform and opacity ever animate, so the GPU composites it without repainting.
// Override the device tier for testing with ?depth=off|lite|full.

import type { DepthId } from "@/lib/look";

export type DepthTier = "off" | "lite" | "full";

type NavExtras = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };

export function detectDepthTier(motion: "on" | "off", pref: DepthId): DepthTier {
  if (typeof window === "undefined") return "off";
  try {
    const forced = new URLSearchParams(window.location.search).get("depth");
    if (forced === "off" || forced === "lite" || forced === "full") return forced;
  } catch {}
  if (pref === "off" || motion === "off") return "off";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "off";
  const nav = navigator as NavExtras;
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? 4;
  if (nav.connection?.saveData) return "lite";
  if (cores <= 4 || memory < 4) return "lite";
  return "full";
}

/* ------------------------------------------------------------------------------------------------
 * Global engine
 * ---------------------------------------------------------------------------------------------- */

/** Surfaces that tilt. `[data-depth-card]` opts anything else in; `[data-depth-flat]` opts out. */
export const TILT_SELECTOR = ".metric-card, .plan-card, .macro-pill, .app-card, .bf-premium-surface, [data-depth-card]";
/** Small cards that also follow the gyroscope in immersive mode (big panels would feel seasick). */
const GYRO_SELECTOR = ".metric-card, .plan-card, .macro-pill, [data-depth-card]";
/** Pressing these never tilts the card around them: typing and dragging must stay steady. */
const STEADY = 'input, textarea, select, [contenteditable="true"], [role="slider"], [data-depth-flat], [data-no-swipe]';

let tier: DepthTier = "off";
let mode: DepthId = "off";
let stopEngine: (() => void) | null = null;

/** Called by DepthRoot whenever the setting, Animations or the device tier changes. */
export function setDepth(nextTier: DepthTier, nextMode: DepthId) {
  const root = document.documentElement;
  root.setAttribute("data-depth", nextTier);
  root.setAttribute("data-depth-mode", nextTier === "off" ? "off" : nextMode);
  if (nextTier === tier && nextMode === mode && stopEngine) return;
  tier = nextTier; mode = nextMode;
  stopEngine?.(); stopEngine = null;
  if (tier !== "off") stopEngine = startEngine(tier === "full" && mode === "immersive");
}

function writeTilt(el: HTMLElement, x: number, y: number) {
  el.style.setProperty("--tilt-x", x.toFixed(3));
  el.style.setProperty("--tilt-y", y.toFixed(3));
}
function clearTilt(el: HTMLElement) {
  el.style.removeProperty("--tilt-x");
  el.style.removeProperty("--tilt-y");
  el.removeAttribute("data-tilt-active");
}

function startEngine(withGyro: boolean): () => void {
  let active: HTMLElement | null = null; // card under a finger / mouse right now
  let pressing = false;

  const cardFor = (target: EventTarget | null): HTMLElement | null => {
    const t = target as HTMLElement | null;
    if (!t?.closest || t.closest(STEADY)) return null;
    const card = t.closest(TILT_SELECTOR) as HTMLElement | null;
    if (!card) return null;
    // big panels that hold a form stay flat: nobody wants a wobbling text box
    if (card.classList.contains("app-card") && card.querySelector("input, textarea, select")) return null;
    return card;
  };
  const aim = (card: HTMLElement, e: PointerEvent, k: number) => {
    const r = card.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // large panels tilt less than small cards so they never look like they are falling over
    const scale = Math.min(1, 360 / Math.max(r.width, r.height)) * k;
    writeTilt(card, (((e.clientX - r.left) / r.width) * 2 - 1) * scale, (((e.clientY - r.top) / r.height) * 2 - 1) * scale);
  };
  const release = () => {
    if (!active) return;
    const card = active; active = null; pressing = false;
    card.removeAttribute("data-tilt-active");
    const g = gyro.last;
    if (withGyro && visible.has(card)) writeTilt(card, g.x, g.y); else clearTilt(card);
  };

  const onDown = (e: PointerEvent) => {
    if (withGyro) gyro.askPermission();
    const card = cardFor(e.target);
    if (!card) return;
    if (active && active !== card) release();
    active = card; pressing = true;
    card.setAttribute("data-tilt-active", "");
    aim(card, e, -0.65); // the touched side sinks
  };
  const onMove = (e: PointerEvent) => {
    if (pressing && active) { aim(active, e, -0.65); return; }
    if (e.pointerType !== "mouse") return;
    const card = cardFor(e.target);
    if (card !== active) { release(); if (card) { active = card; card.setAttribute("data-tilt-active", ""); } }
    if (active) aim(active, e, 0.8); // desktop hover follows the mouse
  };
  const onUp = () => { if (pressing) release(); };
  // a scroll that starts on a card is a scroll, not a press
  const onScroll = () => { if (pressing) release(); };

  document.addEventListener("pointerdown", onDown, { passive: true });
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerup", onUp, { passive: true });
  document.addEventListener("pointercancel", onUp, { passive: true });
  document.addEventListener("scroll", onScroll, { passive: true, capture: true });
  document.documentElement.addEventListener("pointerleave", release);

  // ---- gyroscope parallax: only cards on screen, only in immersive mode on capable phones ----
  const visible = new Set<HTMLElement>();
  let io: IntersectionObserver | null = null;
  let mo: MutationObserver | null = null;
  let unsubGyro: (() => void) | null = null;
  let scanTimer = 0;

  if (withGyro && "IntersectionObserver" in window) {
    io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const el = en.target as HTMLElement;
        if (en.isIntersecting) visible.add(el);
        else { visible.delete(el); if (el !== active) clearTilt(el); }
      }
    });
    const observed = new WeakSet<Element>();
    const scan = () => {
      scanTimer = 0;
      document.querySelectorAll(GYRO_SELECTOR).forEach((el) => { if (!observed.has(el)) { observed.add(el); io!.observe(el); } });
      for (const el of visible) if (!el.isConnected) visible.delete(el);
    };
    scan();
    // screens change on navigation; rescan lazily instead of on every DOM tweak
    mo = new MutationObserver(() => { if (!scanTimer) scanTimer = window.setTimeout(scan, 400); });
    mo.observe(document.body, { childList: true, subtree: true });
    unsubGyro = gyro.subscribe((x, y) => { for (const el of visible) if (el !== active) writeTilt(el, x, y); });
  }

  return () => {
    document.removeEventListener("pointerdown", onDown);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    document.removeEventListener("scroll", onScroll, { capture: true });
    document.documentElement.removeEventListener("pointerleave", release);
    io?.disconnect(); mo?.disconnect(); unsubGyro?.();
    window.clearTimeout(scanTimer);
    if (active) clearTilt(active);
    for (const el of visible) clearTilt(el);
    visible.clear();
  };
}

/* ------------------------------------------------------------------------------------------------
 * One shared device-orientation listener.
 * The first reading becomes "neutral" (however the phone is held) and slowly re-centres, so cards
 * settle flat when the phone is still. Android grants it silently. Where the browser exposes
 * DeviceOrientationEvent.requestPermission() (iOS, newer Chrome), it is asked once on the first tap;
 * Android answers "granted" without a prompt, iOS shows its own prompt.
 * ---------------------------------------------------------------------------------------------- */
type GyroFn = (x: number, y: number) => void;

const gyro = (() => {
  const subs = new Set<GyroFn>();
  let base: { b: number; g: number } | null = null;
  let sx = 0, sy = 0, raf = 0, pending: { b: number; g: number } | null = null;
  const RANGE = 18; // degrees of phone movement for a full tilt
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));

  const flush = () => {
    raf = 0;
    if (!pending) return;
    const { b, g } = pending; pending = null;
    if (!base) base = { b, g };
    base.b += (b - base.b) * 0.01; base.g += (g - base.g) * 0.01; // slow re-centre
    const tx = clamp((g - base.g) / RANGE), ty = clamp((b - base.b) / RANGE);
    sx += (tx - sx) * 0.18; sy += (ty - sy) * 0.18;                // low-pass: no jitter
    api.last = { x: sx, y: sy };
    subs.forEach((f) => f(sx, sy));
  };
  const onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null || document.hidden) return;
    pending = { b: e.beta, g: e.gamma };
    if (!raf) raf = requestAnimationFrame(flush);
  };
  let asked = false;
  /** Must run inside a tap. Harmless where no permission is needed. */
  const askPermission = () => {
    if (asked) return; asked = true;
    const req = (window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> })?.requestPermission;
    if (typeof req === "function") req.call(window.DeviceOrientationEvent).catch(() => {});
  };

  const api = {
    last: { x: 0, y: 0 },
    askPermission,
    subscribe(fn: GyroFn) {
      if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return () => {};
      subs.add(fn);
      if (subs.size === 1) window.addEventListener("deviceorientation", onOrient);
      return () => {
        subs.delete(fn);
        if (subs.size === 0) {
          window.removeEventListener("deviceorientation", onOrient);
          if (raf) cancelAnimationFrame(raf);
          raf = 0; base = null; sx = sy = 0; api.last = { x: 0, y: 0 };
        }
      };
    },
  };
  return api;
})();
