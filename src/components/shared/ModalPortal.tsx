"use client";
/**
 * ModalPortal
 * ───────────
 * Renders its children straight into <body>.
 *
 * Why: a `position: fixed` overlay is positioned against the screen ONLY when none of its ancestors has a
 * transform, filter, backdrop-filter, perspective or running animation. Our cards (`.app-card`, `.fade-in`)
 * do, so a modal opened from inside one lands in the middle of the page instead of covering the screen
 * (you had to scroll to find it, and the blur covered only part of the page).
 *
 * Also locks the page scroll while the modal is open.
 *
 * Usage:  <ModalPortal><div style={{ position: "fixed", inset: 0, ... }}>…</div></ModalPortal>
 */
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return mounted ? createPortal(children, document.body) : null;
}
