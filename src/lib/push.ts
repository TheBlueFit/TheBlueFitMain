/**
 * Push notifications (Firebase Cloud Messaging through @capacitor/push-notifications).
 *
 * Flow: the user allows notifications (first-launch screen) -> the phone gets an FCM token ->
 * we save it on the server (POST /devices/register) -> when a message is sent the backend asks FCM to
 * deliver it, which shows a normal Android notification even when the app is closed or in the background.
 * Tapping the notification opens the right chat.
 */
import { Capacitor } from "@capacitor/core";
import { authSession } from "@/services/api";

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
export const PUSH_TOKEN_KEY = "bluefit_push_token";
export const MESSAGE_CHANNEL_ID = "messages"; // must match android.notification.channel_id sent by the backend

async function saveToken(token: string): Promise<void> {
  const session = authSession.get();
  if (!session?.token || !API_BASE_URL) return;
  try {
    const res = await fetch(`${API_BASE_URL}/devices/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ token, platform: Capacitor.getPlatform() }),
    });
    if (res.ok) localStorage.setItem(PUSH_TOKEN_KEY, token);
  } catch {
    /* offline: it is sent again on the next launch */
  }
}

/** Only ever follow links that stay inside this person's own messages screen. */
export function safeNotificationPath(url: unknown, role?: string): string | null {
  if (typeof url !== "string") return null;
  const area = role === "COACH" ? "/coach/messages" : role === "CLIENT" ? "/client/messages" : null;
  if (!area || !url.startsWith(area)) return null;
  const rest = url.slice(area.length);
  return rest === "" || rest.startsWith("?") ? url : null;
}

interface Handlers {
  /** Called when a notification arrives while the app is open (refresh the unread badge). */
  onForeground: () => void;
  /** Called when the person taps a notification. */
  onOpen: (path: string) => void;
}

/** Registers this phone for push. Does nothing unless notifications were already allowed. Returns a cleanup function. */
export async function startPush({ onForeground, onOpen }: Handlers): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  // Without android/app/google-services.json the Firebase call inside PushNotifications.register() throws on a native
  // thread ("Default FirebaseApp is not initialized") and Android kills the whole app, which JavaScript cannot catch.
  // So push stays off until the Firebase file is added and NEXT_PUBLIC_PUSH_ENABLED=true is set in the build.
  if (process.env.NEXT_PUBLIC_PUSH_ENABLED !== "true") return () => {};
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const perm = await PushNotifications.checkPermissions();
    if (perm.receive !== "granted") return () => {};

    if (Capacitor.getPlatform() === "android") {
      await PushNotifications.createChannel({
        id: MESSAGE_CHANNEL_ID,
        name: "Messages",
        description: "New messages from your coach or athletes",
        importance: 4,
        visibility: 0,
        vibration: true,
      }).catch(() => {});
    }

    const handles = await Promise.all([
      PushNotifications.addListener("registration", (t) => void saveToken(t.value)),
      PushNotifications.addListener("registrationError", (e) => console.warn("Push registration failed", e)),
      PushNotifications.addListener("pushNotificationReceived", () => onForeground()),
      PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
        const path = safeNotificationPath(action.notification?.data?.url, authSession.get()?.role);
        if (path) onOpen(path);
      }),
    ]);
    await PushNotifications.register();
    return () => handles.forEach((h) => void h.remove());
  } catch {
    return () => {};
  }
}
