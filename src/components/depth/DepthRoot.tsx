"use client";

import { useEffect } from "react";
import { useTheme } from "@/components/shell/ThemeProvider";
import { detectDepthTier, setDepth } from "@/lib/depth";

/** Keeps the global 3D engine in step with Appearance > Depth, the Animations switch and the device. Renders nothing. */
export default function DepthRoot() {
  const { look } = useTheme();
  const pref = look.depth || "subtle";
  useEffect(() => {
    const update = () => setDepth(detectDepthTier(look.motion, pref), pref);
    update();
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, [look.motion, pref]);
  return null;
}
