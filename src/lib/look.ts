// look.ts — Blue Fit appearance system
// Replaced: 8 loose styles + 12 loose palettes
// New: 5 complete self-contained themes (each bundles style + palette + surface colours)
// Everything else (scenes, blur, motion, vibrancy, clampLook, applyLook, etc.) is IDENTICAL to the original.

// ─── Core types ───────────────────────────────────────────────────────────────

// ThemeId replaces both StyleId and PaletteId.
// The admin picks ONE theme per role — no separate style/palette knobs.
export type ThemeId =
  | "carbonpulse"    // 1. Carbon Pulse   — deep black, electric green accent (like ref image 1 & 2)
  | "frostedgym"     // 2. Frosted Gym     — dark glass panels, gold accent
  | "ironnation"     // 3. Iron Nation     — concrete dark, bold amber/orange
  | "arcticfit"      // 4. Arctic Fit      — near-white ice, cool blue accent
  | "midnightgold";  // 5. Midnight Gold   — rich dark navy, warm gold

// Keep these for backwards compat — they now map to ThemeId
export type StyleId = ThemeId;
export type PaletteId = ThemeId;

export type BlurId = "off" | "soft" | "strong";
export type SceneId = "auto" | "night" | "morning" | "afternoon" | "evening" | "off";

export interface Look {
  theme: ThemeId;         // replaces both style + palette
  vibrancy: number;
  motion: "on" | "off";
  scene: SceneId;
  blur: BlurId;
  // legacy fields kept so existing saved data doesn't break
  palette?: string;
  style?: string;
}

export type RGB = [number, number, number];

export interface RolePolicy {
  allowCustomize: boolean;
  themes: ThemeId[];                      // replaces styles[] + palettes[]
  scenes: SceneId[];
  allowedLightDarkModes: ("dark" | "light")[];
  allowMotionToggle: boolean;
  allowVibrancy: boolean;
  allowBlur?: boolean;
  resetCounter: number;
  defaults: {
    theme: ThemeId;
    scene: SceneId;
    mode: "dark" | "light";
    motion: "on" | "off";
    vibrancy: number;
    blur?: BlurId;
  };
}

// ─── Storage keys (identical to original) ────────────────────────────────────
export const LOOK_KEY   = "bluefit_look";
export const THEME_KEY  = "bluefit_theme";
export const POLICY_KEY = "bluefit_policy";
export const RESET_KEY  = "bluefit_look_reset";

export const DEFAULT_LOOK: Look = {
  theme: "carbonpulse",
  vibrancy: 100,
  motion: "on",
  scene: "off",   // scene OFF by default
  blur: "soft",
};

// ─── 5 Themes ─────────────────────────────────────────────────────────────────
export interface ThemeDef {
  id: ThemeId;
  label: string;
  blurb: string;

  // accent colours [primary, secondary] for dark + light modes
  dark:  [RGB, RGB];
  light: [RGB, RGB];

  // surface tokens — what actually changes between themes
  darkSurfaces: {
    bgApp: string;
    s0: string; s1: string; s2: string; s3: string;
    bgElev: string;
    borderSubtle: string;
    textPrimary: string;
    textSecondary: string;
  };
  lightSurfaces: {
    bgApp: string;
    s0: string; s1: string; s2: string; s3: string;
    bgElev: string;
    borderSubtle: string;
    textPrimary: string;
    textSecondary: string;
  };

  // radius personality
  radius: { sm: string; md: string; lg: string };

  // font personality (CSS font-family values)
  fontUI: string;
  fontDisplay: string;
}

export const THEMES: ThemeDef[] = [

  // ── 1. Carbon Pulse ─────────────────────────────────────────────────────────
  // Inspired by both reference images: jet black base, vivid electric green action colour.
  // This is the default and matches the bench press tracker aesthetic exactly.
  {
    id: "carbonpulse",
    label: "Carbon Pulse",
    blurb: "Jet black, electric green — built for the gym floor",
    dark:  [[0, 230, 120],  [56, 189, 248]],
    light: [[4,  140, 80],  [3,  105, 161]],
    darkSurfaces: {
      bgApp:        "#000000",
      s0:           "#030405", s1: "#060809", s2: "#0C0D0F", s3: "#111314",
      bgElev:       "#111314",
      borderSubtle: "rgb(255 255 255 / 0.07)",
      textPrimary:  "#FFFFFF",
      textSecondary:"#777E8A",
    },
    lightSurfaces: {
      bgApp:        "#F0F2F5",
      s0:           "#E8EBF0", s1: "#FFFFFF", s2: "#FFFFFF", s3: "#F5F7FA",
      bgElev:       "#FFFFFF",
      borderSubtle: "rgb(10 20 40 / 0.10)",
      textPrimary:  "#0A0F1A",
      textSecondary:"#5A6475",
    },
    radius: { sm: "10px", md: "16px", lg: "22px" },
    fontUI:      "'Outfit', -apple-system, sans-serif",
    fontDisplay: "'Outfit', -apple-system, sans-serif",
  },

  // ── 2. Frosted Gym ───────────────────────────────────────────────────────────
  // Glass/frost aesthetic: slightly lifted dark charcoal, strong backdrop blur,
  // warm gold accent. Premium, editorial, high-end coaching brand feel.
  {
    id: "frostedgym",
    label: "Frosted Gym",
    blurb: "Glass panels, gold shine — premium coaching feel",
    dark:  [[229, 184, 105], [0,  226, 123]],
    light: [[168, 115,  15], [10, 143,  85]],
    darkSurfaces: {
      bgApp:        "#0A0B10",
      s0:           "#0E0F16", s1: "#13151E", s2: "#181B26", s3: "#1E2230",
      bgElev:       "rgb(20 22 34 / 0.85)",
      borderSubtle: "rgb(255 255 255 / 0.10)",
      textPrimary:  "#F0F2FF",
      textSecondary:"#7A80A0",
    },
    lightSurfaces: {
      bgApp:        "#EDF0F7",
      s0:           "#E4E8F2", s1: "#FFFFFF", s2: "#FFFFFF", s3: "#F4F6FB",
      bgElev:       "rgb(255 255 255 / 0.85)",
      borderSubtle: "rgb(15 20 60 / 0.10)",
      textPrimary:  "#0C1030",
      textSecondary:"#5B6080",
    },
    radius: { sm: "12px", md: "18px", lg: "26px" },
    fontUI:      "'Outfit', -apple-system, sans-serif",
    fontDisplay: "'Outfit', -apple-system, sans-serif",
  },

  // ── 3. Iron Nation ───────────────────────────────────────────────────────────
  // Concrete-and-iron gym DNA: near-black but slightly warm, bold orange/amber
  // accent that pops like a neon sign on a dark gym wall.
  {
    id: "ironnation",
    label: "Iron Nation",
    blurb: "Concrete dark, bold orange — raw gym energy",
    dark:  [[251, 146,  60], [250, 204, 21]],
    light: [[194,  65,  12], [161,  98,  7]],
    darkSurfaces: {
      bgApp:        "#080604",
      s0:           "#0E0B08", s1: "#141009", s2: "#1A150E", s3: "#201A12",
      bgElev:       "#201A12",
      borderSubtle: "rgb(255 200 100 / 0.08)",
      textPrimary:  "#F5F0E8",
      textSecondary:"#80756A",
    },
    lightSurfaces: {
      bgApp:        "#F5F0E8",
      s0:           "#EDE8DC", s1: "#FFFFFF", s2: "#FFFFFF", s3: "#F8F5EF",
      bgElev:       "#FFFFFF",
      borderSubtle: "rgb(60 30 10 / 0.12)",
      textPrimary:  "#1A1008",
      textSecondary:"#6A5A48",
    },
    radius: { sm: "6px", md: "10px", lg: "14px" },   // sharper — industrial
    fontUI:      "'Outfit', -apple-system, sans-serif",
    fontDisplay: "'Oswald', 'Outfit', sans-serif",
  },

  // ── 4. Arctic Fit ────────────────────────────────────────────────────────────
  // High-key light mode as default — near white/ice surfaces, cool sky-blue accent.
  // Feels clinical, clean, Scandinavian health-tech.
  {
    id: "arcticfit",
    label: "Arctic Fit",
    blurb: "Ice white, cool blue — crisp and clinical",
    dark:  [[79,  170, 255], [45, 212, 191]],
    light: [[10,  110, 220], [13, 148, 136]],
    darkSurfaces: {
      bgApp:        "#06090F",
      s0:           "#090E18", s1: "#0F1522", s2: "#141D2E", s3: "#18233A",
      bgElev:       "#18233A",
      borderSubtle: "rgb(79 170 255 / 0.12)",
      textPrimary:  "#E8F4FF",
      textSecondary:"#6880A0",
    },
    lightSurfaces: {
      bgApp:        "#F4F8FE",
      s0:           "#EBF2FC", s1: "#FFFFFF", s2: "#FFFFFF", s3: "#F8FBFF",
      bgElev:       "#FFFFFF",
      borderSubtle: "rgb(10 80 180 / 0.10)",
      textPrimary:  "#04101E",
      textSecondary:"#4A6080",
    },
    radius: { sm: "10px", md: "16px", lg: "22px" },
    fontUI:      "'Outfit', -apple-system, sans-serif",
    fontDisplay: "'Outfit', -apple-system, sans-serif",
  },

  // ── 5. Midnight Gold ─────────────────────────────────────────────────────────
  // Deep blue-black (like a night sky), warm gold that reads like ambient gym lighting.
  // Upscale, aspirational, boutique fitness brand energy.
  {
    id: "midnightgold",
    label: "Midnight Gold",
    blurb: "Deep navy, warm gold — boutique fitness luxury",
    dark:  [[229, 184, 105], [167, 139, 250]],
    light: [[140, 100,  20], [109,  40, 217]],
    darkSurfaces: {
      bgApp:        "#04050E",
      s0:           "#07091A", s1: "#0B0E22", s2: "#10142C", s3: "#151A36",
      bgElev:       "#151A36",
      borderSubtle: "rgb(229 184 105 / 0.10)",
      textPrimary:  "#F4F0FF",
      textSecondary:"#706A90",
    },
    lightSurfaces: {
      bgApp:        "#EEEDF8",
      s0:           "#E5E3F4", s1: "#FFFFFF", s2: "#FFFFFF", s3: "#F5F4FC",
      bgElev:       "#FFFFFF",
      borderSubtle: "rgb(10 10 60 / 0.11)",
      textPrimary:  "#080618",
      textSecondary:"#524E72",
    },
    radius: { sm: "10px", md: "16px", lg: "24px" },
    fontUI:      "'Outfit', -apple-system, sans-serif",
    fontDisplay: "'Playfair Display', 'Outfit', serif",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const clampVibrancy = (v: number) =>
  Math.max(40, Math.min(100, Math.round(Number.isFinite(v) ? v : 100)));

/** Alias kept so old imports don't break */
export const STYLES   = THEMES.map((t) => ({ id: t.id as StyleId, label: t.label, blurb: t.blurb, palette: t.id as PaletteId }));
export const PALETTES = THEMES.map((t) => ({ id: t.id as PaletteId, label: t.label, dark: t.dark, light: t.light }));

export const BLURS: { id: BlurId; label: string }[] = [
  { id: "off",    label: "Off"    },
  { id: "soft",   label: "Soft"   },
  { id: "strong", label: "Strong" },
];

export const SCENES: { id: SceneId; label: string }[] = [
  { id: "auto",      label: "Auto (time of day)" },
  { id: "night",     label: "Night"              },
  { id: "morning",   label: "Morning"            },
  { id: "afternoon", label: "Afternoon"          },
  { id: "evening",   label: "Evening"            },
  { id: "off",       label: "Off"                },
];

/** Returns all CSS variables that must be set on <html> for the given look + mode. */
export function computeLookVars(
  look: Look,
  mode: "dark" | "light",
  _palettes?: unknown,         // kept for callers that pass PALETTES
): Record<string, string> | null {
  const themeId = look.theme ?? (look.style as ThemeId) ?? "carbonpulse";
  const def = THEMES.find((t) => t.id === themeId) ?? THEMES[0];

  const vib = clampVibrancy(look.vibrancy);
  const k   = (vib - 40) / 60;    // 0 = most muted, 1 = full colour
  const dark = mode === "dark";

  const [primary, secondary] = dark ? def.dark : def.light;
  const surfaces = dark ? def.darkSurfaces : def.lightSurfaces;

  // soften colours toward grey as vibrancy drops
  const soften = (c: RGB): RGB => {
    const [r, g, b] = c.map((n) => n / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0, s = 0;
    const l = (mx + mn) / 2;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    s *= 0.35 + 0.65 * k;
    const l2 = dark ? l * (0.82 + 0.18 * k) : l;
    const cc = (1 - Math.abs(2 * l2 - 1)) * s;
    const x  = cc * (1 - Math.abs(((h / 60) % 2) - 1));
    const m  = l2 - cc / 2;
    const idx = Math.floor(h / 60) % 6;
    const t = [[cc,x,0],[x,cc,0],[0,cc,x],[0,x,cc],[x,0,cc],[cc,0,x]][idx];
    return t.map((n) => Math.round((n + m) * 255)) as RGB;
  };

  const hex    = (c: RGB) => "#" + c.map((n) => ("0" + n.toString(16)).slice(-2)).join("");
  const triple = (c: RGB) => `${c[0]} ${c[1]} ${c[2]}`;

  const p  = soften(primary as RGB);
  const sc = soften(secondary as RGB);

  // base greys that also shift slightly per theme
  const baseBlue   = dark ? [96,  165, 250] as RGB : [37,  99, 235] as RGB;
  const baseCyan   = dark ? [77,  216, 255] as RGB : [3,  105, 161] as RGB;
  const baseViolet = dark ? [155, 140, 255] as RGB : [109, 40, 217] as RGB;

  return {
    // accent colours
    "--gold-rgb":        triple(p),
    "--accent-gold":     hex(p),
    "--green-rgb":       triple(sc),
    "--accent-green":    hex(sc),
    "--blue-rgb":        triple(soften(baseBlue)),
    "--blue":            hex(soften(baseBlue)),
    "--cyan-rgb":        triple(soften(baseCyan)),
    "--violet-rgb":      triple(soften(baseViolet)),
    // surface colours
    "--bg-app":          surfaces.bgApp,
    "--s0":              surfaces.s0,
    "--s1":              surfaces.s1,
    "--s2":              surfaces.s2,
    "--s3":              surfaces.s3,
    "--bg-elev":         surfaces.bgElev,
    "--border-subtle":   surfaces.borderSubtle,
    "--text-primary":    surfaces.textPrimary,
    "--text-secondary":  surfaces.textSecondary,
    // radius
    "--radius-sm":       def.radius.sm,
    "--radius-md":       def.radius.md,
    "--radius-lg":       def.radius.lg,
    // fonts
    "--font-ui":         def.fontUI,
    "--font-display":    def.fontDisplay,
  };
}

/** Clamp a saved look to what the admin policy allows. Identical logic to original. */
export function clampLook(
  look: Look,
  mode: "dark" | "light",
  pol: RolePolicy | null,
  hasLook: boolean,
  hasMode: boolean,
): { look: Look; theme: "dark" | "light" } {
  if (!pol) return { look, theme: mode };
  const d = pol.defaults;
  const has = (a: string[], v: string) => a.indexOf(v) >= 0;
  if (!pol.allowCustomize) { hasLook = false; hasMode = false; }
  const dBlur = d.blur ?? "soft";
  let out: Look = { ...look, blur: look.blur ?? dBlur };
  if (!hasLook) {
    out = { theme: d.theme, vibrancy: d.vibrancy, motion: d.motion, scene: d.scene, blur: dBlur };
  } else {
    if (!has(pol.themes, out.theme)) out.theme = d.theme;
    if (!has(pol.scenes, out.scene)) out.scene = d.scene;
    if (!pol.allowMotionToggle) out.motion = d.motion;
    if (!pol.allowVibrancy) out.vibrancy = d.vibrancy;
    if (pol.allowBlur === false) out.blur = dBlur;
  }
  const th = hasMode && has(pol.allowedLightDarkModes, mode) ? mode : d.mode;
  return { look: out, theme: th };
}

const VAR_NAMES = [
  "--gold-rgb", "--accent-gold", "--green-rgb", "--accent-green",
  "--blue-rgb", "--blue", "--cyan-rgb", "--violet-rgb",
  "--bg-app", "--s0", "--s1", "--s2", "--s3", "--bg-elev",
  "--border-subtle", "--text-primary", "--text-secondary",
  "--radius-sm", "--radius-md", "--radius-lg",
  "--font-ui", "--font-display",
];

export function readLook(): Look { return readLookRaw().look; }

export function readLookRaw(): { look: Look; has: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOK_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      // migrate old style/palette → theme
      const themeId =
        (THEMES.some((t) => t.id === raw.theme) ? raw.theme : null) ??
        (THEMES.some((t) => t.id === raw.style) ? raw.style : null) ??
        "carbonpulse";
      return {
        has: true,
        look: {
          theme:    themeId as ThemeId,
          vibrancy: clampVibrancy(raw.vibrancy ?? 100),
          motion:   raw.motion === "off" ? "off" : "on",
          scene:    SCENES.some((x) => x.id === raw.scene) ? raw.scene : "off",
          blur:     BLURS.some((x)  => x.id === raw.blur)  ? raw.blur  : "soft",
        },
      };
    }
  } catch {}
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return { has: false, look: { ...DEFAULT_LOOK, motion: reduce ? "off" : "on" } };
}

export function applyLook(look: Look, mode: "dark" | "light") {
  const root = document.documentElement;
  const vars = computeLookVars(look, mode);
  for (const n of VAR_NAMES) root.style.removeProperty(n);
  if (vars) for (const [n, val] of Object.entries(vars)) root.style.setProperty(n, val);
  root.setAttribute("data-theme",   look.theme);
  root.setAttribute("data-palette", look.theme);   // kept for any CSS that uses data-palette
  root.setAttribute("data-style",   look.theme);   // kept for any CSS that uses data-style
  root.setAttribute("data-motion",  look.motion);
  root.setAttribute("data-scene-on", look.scene === "off" ? "0" : "1");
  root.setAttribute("data-blur",    look.blur ?? "soft");
}

export function saveLook(look: Look) {
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch {}
}

/**
 * Inline init script — runs before first paint. Same contract as before.
 * Paste the body of applyLook + readLookRaw into the APPEARANCE_INIT_SCRIPT below.
 */
export const APPEARANCE_INIT_SCRIPT = `(function(){try{
var LOOK_KEY="bluefit_look",THEME_KEY="bluefit_theme",POLICY_KEY="bluefit_policy",RESET_KEY="bluefit_look_reset";
var THEME_IDS=["carbonpulse","frostedgym","ironnation","arcticfit","midnightgold"];
var SCENE_IDS=["auto","night","morning","afternoon","evening","off"];
var BLUR_IDS=["off","soft","strong"];
var raw=null;try{raw=JSON.parse(localStorage.getItem(LOOK_KEY)||"null")}catch(e){}
var pol=null;try{pol=JSON.parse(localStorage.getItem(POLICY_KEY)||"null")}catch(e){}
var savedMode=null;try{savedMode=localStorage.getItem(THEME_KEY)}catch(e){}
var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var look={theme:"carbonpulse",vibrancy:100,motion:reduce?"off":"on",scene:"off",blur:"soft"};
var hasLook=false,hasMode=false;
if(raw&&typeof raw==="object"){
  hasLook=true;
  look.theme=THEME_IDS.indexOf(raw.theme)>=0?raw.theme:(THEME_IDS.indexOf(raw.style)>=0?raw.style:"carbonpulse");
  look.vibrancy=Math.max(40,Math.min(100,Math.round(isFinite(raw.vibrancy)?raw.vibrancy:100)));
  look.motion=raw.motion==="off"?"off":"on";
  look.scene=SCENE_IDS.indexOf(raw.scene)>=0?raw.scene:"off";
  look.blur=BLUR_IDS.indexOf(raw.blur)>=0?raw.blur:"soft";
}
var mode=(savedMode==="light"||savedMode==="dark")?savedMode:"dark";
if(savedMode)hasMode=true;
if(pol&&pol.defaults){
  var d=pol.defaults;
  if(!pol.allowCustomize){hasLook=false;hasMode=false;}
  if(!hasLook){look={theme:d.theme||"carbonpulse",vibrancy:d.vibrancy||100,motion:d.motion||"on",scene:d.scene||"off",blur:d.blur||"soft"};}
  else{
    if(pol.themes&&pol.themes.indexOf(look.theme)<0)look.theme=d.theme||"carbonpulse";
    if(pol.scenes&&pol.scenes.indexOf(look.scene)<0)look.scene=d.scene||"off";
    if(!pol.allowMotionToggle)look.motion=d.motion||"on";
    if(!pol.allowVibrancy)look.vibrancy=d.vibrancy||100;
    if(pol.allowBlur===false)look.blur=d.blur||"soft";
  }
  if(!hasMode||(pol.allowedLightDarkModes&&pol.allowedLightDarkModes.indexOf(mode)<0))mode=d.mode||"dark";
}
var root=document.documentElement;
root.setAttribute("data-theme",look.theme);
root.setAttribute("data-palette",look.theme);
root.setAttribute("data-style",look.theme);
root.setAttribute("data-motion",look.motion);
root.setAttribute("data-scene-on",look.scene==="off"?"0":"1");
root.setAttribute("data-blur",look.blur||"soft");
if(mode==="dark"){root.classList.add("dark");root.setAttribute("data-mode","dark");}
else{root.classList.remove("dark");root.setAttribute("data-mode","light");}
}catch(e){}})();`;
