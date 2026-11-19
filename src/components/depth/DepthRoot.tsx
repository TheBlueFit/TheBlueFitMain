"use client";

import { useEffect } from "react";
import { useTheme } from "@/components/shell/ThemeProvider";
import { depthStore, detectDepthTier } from "@/lib/depth";

/** Keeps <html data-depth> in step with the Animations setting and the device. Renders nothing. */
export default function DepthRoot() {
  const { look } = useTheme();
  useEffect(() => {
    const update = () => depthStore.set(detectDepthTier(look.motion));
    update();
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, [look.motion]);
  return null;
}
