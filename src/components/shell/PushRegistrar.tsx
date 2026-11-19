"use client";

/** Headless: registers this phone for message notifications once the person is signed in and has allowed them. */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { startPush } from "@/lib/push";
import { useApp } from "@/components/shell/AppContext";

export default function PushRegistrar() {
  const router = useRouter();
  const { refreshUnread, session } = useApp();
  const signedIn = !!session?.token && (session.role === "CLIENT" || session.role === "COACH");

  useEffect(() => {
    if (!signedIn) return;
    let stop: (() => void) | undefined;
    let cancelled = false;

    const start = async () => {
      stop?.();
      const cleanup = await startPush({
        onForeground: () => void refreshUnread(),
        onOpen: (path) => router.push(path),
      });
      if (cancelled) cleanup();
      else stop = cleanup;
    };
    void start();

    // The first-launch screen fires this right after the person taps "Allow" on notifications.
    window.addEventListener("bluefit:push-allowed", start);
    return () => {
      cancelled = true;
      window.removeEventListener("bluefit:push-allowed", start);
      stop?.();
    };
  }, [signedIn, router, refreshUnread]);

  return null;
}
