"use client";

import { RefObject, useEffect, useSyncExternalStore } from "react";
import { depthStore, DepthTier } from "@/lib/depth";

/**
 * Makes an element feel like a physical card:
 *   - press: the side under the finger sinks a little, then springs back (lite + full)
 *   - mouse hover on desktop: follows the pointer (lite + full)
 *   - gyroscope: the card tilts gently as the phone moves (full only, only while on screen)
 *
 * Writes only two CSS variables (--tilt-x / --tilt-y, range -1..1) on the element; CSS turns
 * them into transforms. No React re-renders, nothing runs while the card is off screen.
 * Pair with the [data-tilt] rules in globals.css.
 */
export function useDepthTier(): DepthTier {
  return useSyncExternalStore(depthStore.subscribe, depthStore.get, () => "off");
}

export function useTilt<T extends HTMLElement>(ref: RefObject<T | null>, strength = 1) {
  const tier = useDepthTier();

  useEffect(() => {
    const el = ref.current;
    if (!el || tier === "off") return;

    el.setAttribute("data-tilt", "");
    let pressed = false;
    let hovering = false;

    const write = (x: number, y: number) => {
      el.style.setProperty("--tilt-x", (x * strength).toFixed(3));
      el.style.setProperty("--tilt-y", (y * strength).toFixed(3));
    };
    const fromPointer = (e: PointerEvent, sink: number) => {
      const r = el.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = ((e.clientY - r.top) / r.height) * 2 - 1;
      write(x * sink, y * sink);
    };

    const onDown = (e: PointerEvent) => { pressed = true; el.setAttribute("data-tilt-active", ""); fromPointer(e, -0.6); };
    const onMove = (e: PointerEvent) => {
      if (pressed) fromPointer(e, -0.6);
      else if (e.pointerType === "mouse") { hovering = true; el.setAttribute("data-tilt-active", ""); fromPointer(e, 0.8); }
    };
    const onUp = () => { pressed = false; if (!hovering) release(); };
    const onLeave = () => { pressed = false; hovering = false; release(); };
    const release = () => { el.removeAttribute("data-tilt-active"); const g = gyro.last; write(g.x, g.y); };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onLeave);
    el.addEventListener("pointerleave", onLeave);

    // Gyroscope parallax: subscribe only while visible, and only on the full tier.
    let unsub: (() => void) | null = null;
    let io: IntersectionObserver | null = null;
    if (tier === "full" && "IntersectionObserver" in window) {
      io = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting && !unsub) unsub = gyro.subscribe((x, y) => { if (!pressed && !hovering) write(x, y); });
        else if (!entry?.isIntersecting && unsub) { unsub(); unsub = null; }
      });
      io.observe(el);
    }

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onLeave);
      el.removeEventListener("pointerleave", onLeave);
      io?.disconnect();
      unsub?.();
      el.removeAttribute("data-tilt");
      el.removeAttribute("data-tilt-active");
      el.style.removeProperty("--tilt-x");
      el.style.removeProperty("--tilt-y");
    };
  }, [ref, tier, strength]);
}

/* ---------------------------------------------------------------------------------------------
 * One shared device-orientation listener for every tilting card on screen.
 * The first reading becomes "neutral" (however the user holds the phone), and drifts slowly
 * toward the current position so the cards settle flat when the phone is held still.
 * Android WebView delivers these events without a permission prompt; iOS would need
 * DeviceOrientationEvent.requestPermission(), so iOS simply stays on press-to-tilt.
 * ------------------------------------------------------------------------------------------- */
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
    sx += (tx - sx) * 0.18; sy += (ty - sy) * 0.18;                // low-pass to remove jitter
    api.last = { x: sx, y: sy };
    subs.forEach((f) => f(sx, sy));
  };
  const onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null || document.hidden) return;
    pending = { b: e.beta, g: e.gamma };
    if (!raf) raf = requestAnimationFrame(flush);
  };

  const needsPermission = () =>
    typeof (window.DeviceOrientationEvent as unknown as { requestPermission?: unknown })?.requestPermission === "function";

  const api = {
    last: { x: 0, y: 0 },
    subscribe(fn: GyroFn) {
      if (typeof window === "undefined" || !("DeviceOrientationEvent" in window) || needsPermission()) return () => {};
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
