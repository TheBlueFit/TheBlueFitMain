"use client";
/**
 * ThreeDCard.tsx  — src/components/shared/ThreeDCard.tsx
 *
 * ADDITIVE ONLY. This file adds 3D tilt + glow to any card.
 * It does not touch any existing component or CSS class.
 *
 * Usage:
 *   import ThreeDCard from "@/components/shared/ThreeDCard";
 *   <ThreeDCard><YourExistingCard /></ThreeDCard>
 *
 * On desktop  → mouse-follow tilt (GPU transform only, no layout change).
 * On mobile   → device-orientation tilt (gyroscope, same math).
 * When prefers-reduced-motion is set → no tilt, no animation at all.
 * When data-motion="off" on <html> → same as reduced-motion.
 *
 * Performance rules followed:
 *  • Only `transform` and `box-shadow` change — both are GPU-composited.
 *  • `will-change: transform` is set only while the pointer is inside.
 *  • The perspective is on a wrapper div (display: contents doesn't work
 *    for perspective, so the wrapper is display:block with zero extra layout).
 *  • The rAF loop stops the moment the pointer leaves and the card resets.
 */

import React, {
  useRef,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_DEG       = 10;          // maximum tilt in degrees
const PERSPECTIVE   = 900;         // px
const LERP          = 0.14;        // interpolation speed (0 = no movement, 1 = instant)
const RESET_DUR     = "0.55s";
const RESET_EASE    = "cubic-bezier(0.23, 1, 0.32, 1)";
const SCALE_HOVER   = 1.013;
const GLOW_COLOR    = "rgb(var(--gold-rgb) / 0.30)";
const GLOW_SHADOW   = `0 0 22px 8px ${GLOW_COLOR}, 0 16px 36px rgba(0,0,0,0.26)`;
const REST_SHADOW   = "0 4px 20px rgba(0,0,0,0.18)";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function motionAllowed(): boolean {
  if (typeof window === "undefined") return false;
  if (document.documentElement.dataset.motion === "off") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface ThreeDCardProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Set true to show a coloured glow on hover. Default: true */
  showGlow?: boolean;
  /** Override glow CSS colour string */
  glowColor?: string;
  /** Disable tilt without removing the wrapper */
  disabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function ThreeDCard({
  children,
  className = "",
  style = {},
  showGlow = true,
  glowColor = GLOW_SHADOW,
  disabled = false,
}: ThreeDCardProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const rafRef   = useRef<number>(0);
  const liveRef  = useRef(false);   // is the pointer inside?

  const curX  = useRef(0);
  const curY  = useRef(0);
  const tgtX  = useRef(0);
  const tgtY  = useRef(0);

  const [hovered, setHovered] = useState(false);
  const [reduced] = useState(() => !motionAllowed());

  // apply transform directly — avoids React re-render on every frame
  const applyTransform = useCallback((rx: number, ry: number, scale: number) => {
    if (!innerRef.current) return;
    innerRef.current.style.transform =
      `perspective(${PERSPECTIVE}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale3d(${scale},${scale},1)`;
  }, []);

  // rAF loop — lerp toward target
  const loop = useCallback(() => {
    if (!liveRef.current) return;
    curX.current += (tgtX.current - curX.current) * LERP;
    curY.current += (tgtY.current - curY.current) * LERP;
    applyTransform(curX.current, curY.current, SCALE_HOVER);
    rafRef.current = requestAnimationFrame(loop);
  }, [applyTransform]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || reduced || !outerRef.current) return;
    const r = outerRef.current.getBoundingClientRect();
    const x = (e.clientX - r.left)  / r.width  - 0.5;
    const y = (e.clientY - r.top)   / r.height - 0.5;
    tgtX.current = -y * MAX_DEG;
    tgtY.current =  x * MAX_DEG;
  }, [disabled, reduced]);

  const handleMouseEnter = useCallback(() => {
    if (disabled || reduced) return;
    setHovered(true);
    if (innerRef.current) {
      innerRef.current.style.transition = "";
      innerRef.current.style.willChange = "transform";
    }
    liveRef.current = true;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(loop);
  }, [disabled, reduced, loop]);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
    liveRef.current = false;
    cancelAnimationFrame(rafRef.current);
    tgtX.current = 0;
    tgtY.current = 0;
    if (innerRef.current) {
      innerRef.current.style.transition = `transform ${RESET_DUR} ${RESET_EASE}`;
    }
    applyTransform(0, 0, 1);
    // clear transition after it finishes so the loop can run cleanly next time
    const tid = window.setTimeout(() => {
      if (innerRef.current) innerRef.current.style.transition = "";
      innerRef.current && (innerRef.current.style.willChange = "auto");
      curX.current = 0;
      curY.current = 0;
    }, 600);
    return () => window.clearTimeout(tid);
  }, [applyTransform]);

  // device orientation for touch-only phones (gyroscope)
  useEffect(() => {
    if (disabled || reduced || typeof window === "undefined") return;
    if (window.matchMedia("(pointer: fine)").matches) return; // desktop has mouse

    let active = false;
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (!hovered) return;
      const beta  = Math.min(Math.max((e.beta  ?? 0) - 20, -MAX_DEG), MAX_DEG);
      const gamma = Math.min(Math.max(e.gamma ?? 0,         -MAX_DEG), MAX_DEG);
      tgtX.current = (beta  / MAX_DEG) * MAX_DEG * 0.5;
      tgtY.current = (gamma / MAX_DEG) * MAX_DEG * 0.5;
    };

    const request = async () => {
      if (active) return;
      if (typeof (DeviceOrientationEvent as any).requestPermission === "function") {
        try {
          if (await (DeviceOrientationEvent as any).requestPermission() !== "granted") return;
        } catch { return; }
      }
      active = true;
      window.addEventListener("deviceorientation", onOrientation);
    };
    const el = outerRef.current;
    el?.addEventListener("touchstart", request, { once: true, passive: true });
    return () => {
      el?.removeEventListener("touchstart", request);
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, [disabled, reduced, hovered]);

  // cleanup on unmount
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); liveRef.current = false; }, []);

  const shadowStyle: CSSProperties = !reduced && hovered && showGlow
    ? { boxShadow: glowColor, transition: "box-shadow 0.25s ease" }
    : { boxShadow: REST_SHADOW, transition: "box-shadow 0.4s ease" };

  return (
    <div
      ref={outerRef}
      className={`bf3d-outer ${className}`}
      style={{ display: "block", ...style }}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        ref={innerRef}
        className="bf3d-inner"
        style={{
          transformStyle: "preserve-3d",
          transform: `perspective(${PERSPECTIVE}px) rotateX(0deg) rotateY(0deg) scale3d(1,1,1)`,
          borderRadius: "inherit",
          ...shadowStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * ThreeDGrid — lays out children in a responsive grid where each child is
 * wrapped in ThreeDCard with a staggered entrance animation.
 *
 * Usage:
 *   <ThreeDGrid columns={2}>
 *     <MetricCard ... />
 *     <MetricCard ... />
 *   </ThreeDGrid>
 */
export function ThreeDGrid({
  children,
  columns = 2,
  gap = 14,
  className = "",
}: {
  children: ReactNode;
  columns?: number;
  gap?: number;
  className?: string;
}) {
  return (
    <div
      className={`bf3d-grid ${className}`}
      style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`, gap }}
    >
      {React.Children.map(children, (child, i) => (
        <ThreeDCard style={{ "--bf3d-delay": `${i * 55}ms` } as CSSProperties}>
          {child}
        </ThreeDCard>
      ))}
    </div>
  );
}
