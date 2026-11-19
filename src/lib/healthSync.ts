/**
 * Health sync engine (Android Health Connect / iOS HealthKit through @capgo/capacitor-health).
 *
 * One place owns reading the phone's health data, so the manual "Sync now" button and the
 * automatic sync that runs whenever the app is opened / brought back to the foreground behave
 * identically and can never run at the same time.
 *
 * Fixes compared with the previous in-component version:
 *  - steps/calories are read with queryAggregated (the OS adds them up). readSamples returns only the
 *    newest 100 records by default, so busy days were under-counted.
 *  - only TODAY's numbers are ever saved. Before, picking "7 Days" / "30 Days" saved the 7/30-day TOTAL as today's steps.
 *  - the day key sent to the server is the phone's local date (the server used UTC, so between midnight and
 *    05:30 in India today's steps landed on yesterday).
 *  - permission is read from the OS (checkAuthorization), not from a flag remembered in localStorage.
 *  - sleep is the union of real "asleep" intervals (awake / in-bed time and overlapping records are not counted).
 */
import { Capacitor } from "@capacitor/core";
import { authSession, getLocalDateISO } from "@/services/api";

export type SyncRange = "today" | "7d" | "30d";
export type HealthPermission = "granted" | "prompt" | "unavailable";

export interface HealthReading {
  steps?: number;
  sleepHours?: number;
  calories?: number;
  heartRate?: number;
  lastSynced?: string;
  range?: SyncRange;
}

export interface SyncSnapshot {
  status: "idle" | "syncing" | "done" | "error";
  reading: HealthReading | null;
  error: string | null;
}

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const READ_TYPES = ["steps", "sleep", "calories", "heartRate"];
/** Opening the app twice within this window only syncs once. */
export const AUTO_SYNC_MIN_GAP_MS = 2 * 60 * 1000;

// ── tiny external store so every component sees the same status ──────────────
let snapshot: SyncSnapshot = { status: "idle", reading: null, error: null };
const listeners = new Set<() => void>();
function setSnapshot(next: SyncSnapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}
export const healthStore = {
  get: () => snapshot,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

// ── plugin access ────────────────────────────────────────────────────────────
// The plugin's types differ between versions, so it is used through `any` on purpose.
// IMPORTANT: a Capacitor plugin object must never be returned from an async function or passed to `await`/`resolve`.
// JavaScript then asks it for `.then`, and Capacitor answers '"Health.then()" is not implemented on android', which
// rejected every call before it reached the phone (so no Health Connect dialog could ever open). It is wrapped in a
// plain object instead.
async function plugin(): Promise<{ Health: any }> {
  const mod: any = await import("@capgo/capacitor-health");
  return { Health: mod.Health };
}

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Never wait forever on a native call: resolves to `fallback` if the plugin errors or does not answer in time. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/** How long the Health Connect dialog may stay unanswered before the app moves on. */
const HEALTH_DIALOG_TIMEOUT_MS = 30_000;
const HEALTH_CALL_TIMEOUT_MS = 8_000;

/** Why Health access is not usable. `null` = nothing wrong. */
export type HealthIssue =
  | "no-plugin"        // the native health plugin is missing from this APK / IPA (rebuild: npm run build, npx cap sync)
  | "not-installed"    // Android 13 or older without the "Health Connect by Android" app (or unsupported device)
  | "update-required"  // Health Connect is installed but too old
  | "blocked"          // Android stopped showing the pop-up (denied twice): the user must allow it in Health Connect settings
  | null;

export interface HealthStatus {
  permission: HealthPermission;
  issue: HealthIssue;
  /** Plain-English detail from the OS / plugin, useful on screen and in Logcat. */
  detail?: string;
}

export const HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata";

/** Set when a permission request came back instantly without the user choosing "Allow" (Android suppressed the dialog). */
let dialogBlocked = false;

function isAndroid(): boolean {
  try {
    return Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

function classifyAvailability(avail: any): { issue: HealthIssue; detail?: string } {
  const reason = String(avail?.reason || "");
  if (/update/i.test(reason)) return { issue: "update-required", detail: reason };
  return { issue: isAndroid() ? "not-installed" : null, detail: reason || undefined };
}

async function readStatus(): Promise<HealthStatus> {
  let Health: any;
  try {
    ({ Health } = await plugin());
  } catch (e: any) {
    return { permission: "unavailable", issue: "no-plugin", detail: e?.message };
  }
  try {
    const avail = await Health.isAvailable();
    if (!avail?.available) {
      const { issue, detail } = classifyAvailability(avail);
      return { permission: "unavailable", issue, detail };
    }
    const status = await Health.checkAuthorization({ read: READ_TYPES, write: [] });
    if ((status?.readAuthorized || []).includes("steps")) {
      dialogBlocked = false;
      return { permission: "granted", issue: null };
    }
    return { permission: "prompt", issue: dialogBlocked ? "blocked" : null };
  } catch (e: any) {
    const msg = String(e?.message || e || "");
    // Capacitor throws "... plugin is not implemented on android" when the native side was never built in.
    const missing = /not implemented|not available|UNIMPLEMENTED/i.test(msg);
    return { permission: "unavailable", issue: missing ? "no-plugin" : null, detail: msg };
  }
}

/** Real permission state + the reason when it is not usable. Never shows a dialog, and never hangs. */
export async function getHealthStatus(): Promise<HealthStatus> {
  if (!isNative()) return { permission: "unavailable", issue: null };
  return withTimeout<HealthStatus>(readStatus(), HEALTH_CALL_TIMEOUT_MS, { permission: "prompt", issue: null });
}

/** Real permission state from the OS. Never shows a dialog, and never hangs (no answer = "prompt"). */
export async function getHealthPermission(): Promise<HealthPermission> {
  return (await getHealthStatus()).permission;
}

/** Shows the OS permission dialog (Health Connect / HealthKit) and reports what the user chose.
 *  If the system never answers (Health Connect not responding) it gives up after HEALTH_DIALOG_TIMEOUT_MS
 *  so the permission screen can carry on to the next item.
 *  If the call returns within a second without a grant, Android did not show the dialog (it stops after two
 *  denials); that is remembered as the "blocked" issue so the UI can send the user to Health Connect settings. */
export async function requestHealthAccess(): Promise<HealthPermission> {
  if (!isNative()) return "unavailable";
  try {
    const { Health } = await plugin();
    const avail: any = await withTimeout(Health.isAvailable(), HEALTH_CALL_TIMEOUT_MS, null);
    if (!avail) return "prompt";
    if (!avail.available) return "unavailable";
    const t0 = Date.now();

    // The plugin's promise can be lost if Android recreates the activity while the Health Connect screen is open
    // (the permission IS granted but the call never answers). So every request is raced against a poll of the OS
    // every 1.5 s, and we stop waiting the moment access shows up.
    const waitForGrant = async (request: Promise<unknown>) => {
      let stopPoll = () => {};
      const polled = new Promise<null>((resolve) => {
        let busy = false;
        const timer = setInterval(async () => {
          if (busy) return;
          busy = true;
          try {
            if ((await readStatus()).permission === "granted") { clearInterval(timer); resolve(null); }
          } finally { busy = false; }
        }, 1500);
        stopPoll = () => clearInterval(timer);
      });
      await withTimeout(Promise.race([request, polled]), HEALTH_DIALOG_TIMEOUT_MS, null);
      stopPoll();
    };

    // 1) Android: ask through the official @capacitor/health-fitness plugin (the way the earlier, working build did).
    //    Health Connect permissions belong to the app, so whatever this grants the reading code below can use.
    if (isAndroid()) {
      await waitForGrant(requestViaHealthFitness());
    }
    // 2) Everything else (and Android if that did not grant): the Capgo plugin's own request.
    if ((await getHealthPermission()) !== "granted") {
      await waitForGrant(Health.requestAuthorization({ read: READ_TYPES, write: [] }));
    }

    const quick = Date.now() - t0 < 1200;
    const after = await getHealthPermission();
    dialogBlocked = isAndroid() && quick && after !== "granted";
    return after;
  } catch {
    /* fall through: the check below is the source of truth */
  }
  return getHealthPermission();
}

/** Android only. Resolves when the plugin call ends; errors are swallowed (the OS check afterwards is the truth). */
async function requestViaHealthFitness(): Promise<void> {
  try {
    const mod: any = await import("@capacitor/health-fitness");
    const read = (Variable: string) => ({ Variable, AccessType: "READ" });
    const off = JSON.stringify({ IsActive: false, AccessType: "READ" });
    await mod.HealthFitness.requestHealthPermissions({
      customPermissions: JSON.stringify([read("STEPS"), read("CALORIES_BURNED"), read("SLEEP"), read("HEART_RATE")]),
      allVariables: off,
      fitnessVariables: off,
      healthVariables: off,
      profileVariables: off,
      workoutVariables: off,
    });
  } catch {
    /* plugin missing, no privacy policy URL configured, or user cancelled */
  }
}

/** Opens Health Connect's own permission screen so the user can allow The Blue Fit manually (Android). */
export async function openHealthSettings(): Promise<void> {
  try {
    const { Health } = await plugin();
    await Health.openHealthConnectSettings();
    return;
  } catch {
    /* fall back to this app's system settings page */
  }
  try {
    const { NativeSettings, AndroidSettings, IOSSettings } = await import("capacitor-native-settings");
    await NativeSettings.open({ optionAndroid: AndroidSettings.ApplicationDetails, optionIOS: IOSSettings.App });
  } catch { /* nothing else to try */ }
}

/** Opens the Play Store page of "Health Connect by Android" (needed on Android 13 and older, or when it is outdated). */
export function openHealthConnectInstall(): void {
  try {
    window.location.href = `market://details?id=${HEALTH_CONNECT_PACKAGE}`;
    setTimeout(() => {
      // If the Play Store app did not take over, fall back to the web page.
      if (document.visibilityState === "visible") {
        window.open(`https://play.google.com/store/apps/details?id=${HEALTH_CONNECT_PACKAGE}`, "_blank");
      }
    }, 1500);
  } catch { /* ignore */ }
}

// ── reading ──────────────────────────────────────────────────────────────────
const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 0, 0, 0, 0);
};
const rangeDays = (r: SyncRange) => (r === "today" ? 1 : r === "7d" ? 7 : 30);
function rangeStart(r: SyncRange): Date {
  if (r === "today") return startOfToday();
  const d = startOfToday();
  d.setDate(d.getDate() - (rangeDays(r) - 1));
  return d;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

async function aggregate(Health: any, dataType: string, aggregation: "sum" | "average", start: Date, end: Date) {
  try {
    const res = await Health.queryAggregated({
      dataType,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      bucket: "day",
      aggregation,
    });
    const values: number[] = (res?.samples || []).map((s: any) => Number(s?.value)).filter(finite);
    if (!values.length) return undefined;
    return aggregation === "sum"
      ? values.reduce((a, b) => a + b, 0)
      : values.reduce((a, b) => a + b, 0) / values.length;
  } catch {
    // Older plugin builds: fall back to raw samples (large limit, not the default 100)
    try {
      const res = await Health.readSamples({
        dataType,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        limit: 20000,
      });
      const values: number[] = (res?.samples || []).map((s: any) => Number(s?.value)).filter(finite);
      if (!values.length) return undefined;
      const total = values.reduce((a, b) => a + b, 0);
      return aggregation === "sum" ? total : total / values.length;
    } catch {
      return undefined;
    }
  }
}

const NOT_ASLEEP = new Set(["awake", "inbed", "outofbed"]);

async function sleepHoursBetween(Health: any, start: Date, end: Date): Promise<number | undefined> {
  try {
    const res = await Health.readSamples({
      dataType: "sleep",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      limit: 5000,
    });
    const spans: Array<[number, number]> = [];
    for (const s of res?.samples || []) {
      if (NOT_ASLEEP.has(String(s?.sleepState || "").toLowerCase())) continue;
      const a = Date.parse(s?.startDate);
      const b = Date.parse(s?.endDate);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) spans.push([a, b]);
    }
    if (!spans.length) return undefined;
    spans.sort((x, y) => x[0] - y[0]);
    let total = 0;
    let [curA, curB] = spans[0];
    for (const [a, b] of spans.slice(1)) {
      if (a <= curB) curB = Math.max(curB, b);
      else {
        total += curB - curA;
        [curA, curB] = [a, b];
      }
    }
    total += curB - curA;
    return total / 3_600_000;
  } catch {
    return undefined;
  }
}

async function readRange(range: SyncRange): Promise<Omit<HealthReading, "lastSynced">> {
  const { Health } = await plugin();
  const end = new Date();
  const start = rangeStart(range);
  const days = rangeDays(range);
  // "Last night" belongs to today: look back to 18:00 the evening before.
  const sleepStart = new Date(start.getTime() - 6 * 3_600_000);

  const [steps, calories, hr, sleep] = await Promise.all([
    aggregate(Health, "steps", "sum", start, end),
    aggregate(Health, "calories", "sum", start, end),
    aggregate(Health, "heartRate", "average", start, end),
    sleepHoursBetween(Health, sleepStart, end),
  ]);

  // For 7 / 30 days the card shows per-day averages so the numbers stay comparable with the daily goals.
  const per = (v?: number) => (v == null ? undefined : Math.round(v / days));
  const sleepPer = sleep == null ? undefined : Math.round((sleep / days) * 10) / 10;
  return {
    steps: range === "today" ? (steps == null ? undefined : Math.round(steps)) : per(steps),
    calories: range === "today" ? (calories == null ? undefined : Math.round(calories)) : per(calories),
    sleepHours: range === "today" ? (sleep == null ? undefined : Math.round(sleep * 10) / 10) : sleepPer,
    heartRate: hr == null ? undefined : Math.round(hr),
    range,
  };
}

// ── saving (today only) ──────────────────────────────────────────────────────
async function saveToday(data: Omit<HealthReading, "lastSynced" | "range">): Promise<boolean> {
  const token = authSession.get()?.token;
  if (!token || !API_BASE_URL) return false;
  const body: Record<string, unknown> = { date: getLocalDateISO() };
  let any = false;
  for (const k of ["steps", "sleepHours", "calories", "heartRate"] as const) {
    if (finite(data[k])) {
      body[k] = data[k];
      any = true;
    }
  }
  if (!any) return false;
  try {
    const res = await fetch(`${API_BASE_URL}/athlete/health-metrics`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── public entry points ──────────────────────────────────────────────────────
let inFlight: Promise<HealthReading | null> | null = null;
let lastRunAt = 0;

/** Reads the phone and (for "today") saves to the server. Safe to call from anywhere; overlapping calls share one run. */
export function syncHealth(range: SyncRange = "today"): Promise<HealthReading | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    setSnapshot({ ...snapshot, status: "syncing", error: null });
    try {
      const data = await readRange(range);
      const reading: HealthReading = { ...data, lastSynced: new Date().toISOString() };
      if (range === "today") {
        const { range: _r, ...metrics } = data;
        void _r;
        await saveToday(metrics);
      }
      lastRunAt = Date.now();
      setSnapshot({ status: "done", reading, error: null });
      return reading;
    } catch (err: any) {
      setSnapshot({ ...snapshot, status: "error", error: err?.message || "Could not read health data." });
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Called whenever the app opens or returns to the foreground. Does nothing unless the user has already
 * allowed Health access (so it never pops up a dialog by surprise) and the last sync was a while ago.
 */
export async function autoSyncIfAllowed(force = false): Promise<HealthReading | null> {
  if (!isNative()) return null;
  if (authSession.get()?.role !== "CLIENT") return null;
  if (!force && Date.now() - lastRunAt < AUTO_SYNC_MIN_GAP_MS) return null;
  if ((await getHealthPermission()) !== "granted") return null;
  return syncHealth("today");
}
