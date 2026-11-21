// FIVE THEMES. Each theme is a complete, preset look: surface style (CSS: data-style),
// accent palette (inline CSS variables) and effect level. People pick a theme, nothing else.
// The admin decides which of the five a role may use, and which one they start with.
// Pure and self-contained so the same code runs before first paint (see APPEARANCE_INIT_SCRIPT).

export type PaletteId = "noir" | "volt" | "forest" | "iron" | "carbon" | "classic" | "ocean" | "violet" | "rose" | "ember" | "mint" | "graphite" | "sepia" | "azure" | "emerald" | "coral";
export type StyleId = "original" | "glass" | "vintage" | "oldgym" | "moderngym" | "navy" | "forest" | "coral" | "liquidcarbon";
export type BlurId = "off" | "soft" | "strong";
export type SceneId = "auto" | "night" | "morning" | "afternoon" | "evening" | "off";
export type DepthId = "off" | "subtle" | "immersive";
export type ThemeId = "noir" | "volt" | "forest" | "iron" | "carbon";
export type Mode = "dark" | "light";

export interface Look {
  /** the theme this look came from */
  preset: ThemeId;
  palette: PaletteId;
  vibrancy: number;
  motion: "on" | "off";
  style: StyleId;
  scene: SceneId;
  blur: BlurId;
  depth: DepthId;
}

/** The admin's limits for one role. Five themes only, plus which one people start with. */
export interface RolePolicy {
  allowCustomize: boolean;
  themes: ThemeId[];
  defaultTheme: ThemeId;
  resetCounter: number;
}

export type RGB = [number, number, number];

export const LOOK_KEY = "bluefit_look";
export const THEME_KEY = "bluefit_theme";
export const POLICY_KEY = "bluefit_policy";
export const RESET_KEY = "bluefit_look_reset";
/** "1" / "0": the admin's brand-wide mascot switch, cached so it applies before first paint. */
export const MASCOT_KEY = "bluefit_mascot";

/** primary replaces the gold role, secondary the green role. Light values are darker so text stays readable. */
export const PALETTES: { id: PaletteId; label: string; dark: [RGB, RGB]; light: [RGB, RGB] }[] = [
  { id: "noir", label: "Studio White", dark: [[245, 247, 250], [52, 211, 153]], light: [[51, 65, 85], [4, 120, 87]] },
  { id: "volt", label: "Volt Lime", dark: [[198, 241, 53], [196, 181, 253]], light: [[63, 98, 18], [109, 40, 217]] },
  { id: "forest", label: "Chlorophyll", dark: [[205, 235, 69], [74, 222, 128]], light: [[77, 102, 10], [5, 122, 85]] },
  { id: "iron", label: "Brass & Chalk", dark: [[232, 192, 122], [168, 162, 152]], light: [[120, 84, 30], [71, 85, 105]] },
  { id: "carbon", label: "Teal Pulse", dark: [[45, 212, 191], [165, 243, 252]], light: [[13, 148, 136], [3, 105, 161]] },
  // kept so looks saved before the five-theme update still resolve to a colour
  { id: "classic", label: "Classic", dark: [[229, 184, 105], [0, 226, 123]], light: [[168, 115, 15], [10, 143, 85]] },
  { id: "ocean", label: "Ocean", dark: [[56, 189, 248], [45, 212, 191]], light: [[3, 105, 161], [13, 148, 136]] },
  { id: "violet", label: "Violet", dark: [[167, 139, 250], [232, 121, 249]], light: [[109, 40, 217], [162, 28, 175]] },
  { id: "rose", label: "Rose", dark: [[251, 113, 133], [251, 191, 36]], light: [[190, 18, 60], [180, 83, 9]] },
  { id: "ember", label: "Ember", dark: [[251, 146, 60], [250, 204, 21]], light: [[194, 65, 12], [161, 98, 7]] },
  { id: "mint", label: "Mint", dark: [[52, 211, 153], [125, 211, 252]], light: [[4, 120, 87], [3, 105, 161]] },
  { id: "graphite", label: "Graphite", dark: [[212, 212, 220], [148, 163, 184]], light: [[51, 65, 85], [71, 85, 105]] },
  { id: "sepia", label: "Sepia", dark: [[214, 170, 110], [176, 110, 70]], light: [[132, 84, 36], [118, 58, 30]] },
  { id: "azure", label: "Azure", dark: [[79, 140, 255], [45, 212, 191]], light: [[36, 89, 230], [15, 143, 111]] },
  { id: "emerald", label: "Emerald", dark: [[52, 211, 153], [250, 204, 21]], light: [[4, 120, 87], [161, 98, 7]] },
  { id: "coral", label: "Coral", dark: [[255, 107, 87], [125, 211, 252]], light: [[200, 52, 35], [3, 105, 161]] },
];

/** Surface / typography styles used by the five themes (CSS lives in globals.css, keyed on data-style). */
export const STYLES: { id: StyleId; label: string; blurb: string }[] = [
  { id: "original", label: "Original", blurb: "Your signature dark look" },
  { id: "moderngym", label: "Modern Gym", blurb: "Sharp, athletic, high contrast" },
  { id: "forest", label: "Forest Energy", blurb: "Fresh fitness green" },
  { id: "oldgym", label: "Old Gym", blurb: "Concrete, chalk and iron" },
  { id: "liquidcarbon", label: "Liquid Carbon", blurb: "Carbon fibre depth, teal pulse" },
];

export const BLURS: { id: BlurId; label: string }[] = [
  { id: "off", label: "Off" }, { id: "soft", label: "Soft" }, { id: "strong", label: "Strong" },
];

export const DEPTHS: { id: DepthId; label: string; blurb: string }[] = [
  { id: "off", label: "Flat", blurb: "No 3D effects" },
  { id: "subtle", label: "Subtle", blurb: "Cards tilt under your finger" },
  { id: "immersive", label: "Immersive", blurb: "Cards follow your phone's movement" },
];

export const SCENES: { id: SceneId; label: string }[] = [
  { id: "auto", label: "Auto (time of day)" }, { id: "night", label: "Night" }, { id: "morning", label: "Morning" },
  { id: "afternoon", label: "Afternoon" }, { id: "evening", label: "Evening" }, { id: "off", label: "Off" },
];

/** The five themes. Each one is a finished design; nobody assembles their own. */
export const THEMES: {
  id: ThemeId; label: string; blurb: string;
  style: StyleId; palette: PaletteId; scene: SceneId; blur: BlurId; depth: DepthId; vibrancy: number; mode: Mode;
}[] = [
  {
    id: "noir", label: "Cinematic Noir", blurb: "Near-black canvas, studio light and a signal-green tick",
    style: "original", palette: "noir", scene: "off", blur: "off", depth: "subtle", vibrancy: 100, mode: "dark",
  },
  {
    id: "volt", label: "Volt", blurb: "Charcoal, condensed caps and electric lime",
    style: "moderngym", palette: "volt", scene: "off", blur: "soft", depth: "subtle", vibrancy: 100, mode: "dark",
  },
  {
    id: "forest", label: "Forest Pulse", blurb: "Deep green surfaces with chlorophyll accents",
    style: "forest", palette: "forest", scene: "off", blur: "soft", depth: "subtle", vibrancy: 100, mode: "dark",
  },
  {
    id: "iron", label: "Iron & Chalk", blurb: "Concrete, brass and chalk-dust white",
    style: "oldgym", palette: "iron", scene: "off", blur: "off", depth: "off", vibrancy: 90, mode: "dark",
  },
  {
    id: "carbon", label: "Liquid Carbon", blurb: "Carbon-fibre depth with a cool teal pulse",
    style: "liquidcarbon", palette: "carbon", scene: "off", blur: "strong", depth: "subtle", vibrancy: 100, mode: "dark",
  },
];

export const THEME_IDS: ThemeId[] = THEMES.map((t) => t.id);
export const DEFAULT_THEME: ThemeId = "noir";

const clampVib = (v: number) => Math.max(40, Math.min(100, Math.round(Number.isFinite(v) ? v : 100)));

/** The complete look for one theme, with animations left to the caller. */
export function presetLook(id: ThemeId): Look {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  return {
    preset: t.id, style: t.style, palette: t.palette, vibrancy: t.vibrancy,
    motion: "on", scene: t.scene, blur: t.blur, depth: t.depth,
  };
}

export const DEFAULT_LOOK: Look = presetLook(DEFAULT_THEME);

/** Themes are always dark for now; the mode travels with the theme so light themes can be added later. */
export const THEME_MODES: Record<ThemeId, Mode> = THEMES.reduce((acc, t) => { acc[t.id] = t.mode; return acc; }, {} as Record<ThemeId, Mode>);
export const themeOf = (look: Look): Mode => THEME_MODES[look.preset] || "dark";

export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && THEME_IDS.indexOf(v as ThemeId) >= 0;

/** Two swatch colours for the theme picker (dark-mode accents). */
export function themeSwatch(id: ThemeId): [string, string] {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  const pal = PALETTES.find((p) => p.id === t.palette) || PALETTES[0];
  const rgb = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
  return [rgb(pal.dark[0]), rgb(pal.dark[1])];
}

export const clampVibrancy = clampVib;

/**
 * Returns the CSS variables to set on <html> for a look + theme, or null for the untouched original
 * (Classic at full vibrancy). Self-contained on purpose: it is also serialised into the inline init script.
 */
export function computeLookVars(look: Look, theme: Mode, palettes: typeof PALETTES): Record<string, string> | null {
  const pal = palettes.find((p) => p.id === look.palette) || palettes[0];
  const vib = Math.max(40, Math.min(100, Number(look.vibrancy) || 100));
  if (pal.id === "classic" && vib >= 100) return null;

  const k = (vib - 40) / 60; // 0 = most muted, 1 = full colour
  const dark = theme === "dark";
  const [primary, secondary] = dark ? pal.dark : pal.light;
  const base = dark
    ? { blue: [96, 165, 250], cyan: [77, 216, 255], violet: [155, 140, 255] }
    : { blue: [37, 99, 235], cyan: [3, 105, 161], violet: [109, 40, 217] };

  const soften = (c: number[]): number[] => {
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0, s = 0; const l = (mx + mn) / 2;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    s *= 0.35 + 0.65 * k;                       // fade saturation toward grey
    const l2 = dark ? l * (0.82 + 0.18 * k) : l; // on black, vivid colours also glow less
    const cc = (1 - Math.abs(2 * l2 - 1)) * s, x = cc * (1 - Math.abs(((h / 60) % 2) - 1)), m = l2 - cc / 2;
    const sec = Math.floor(h / 60) % 6;
    const t = [[cc, x, 0], [x, cc, 0], [0, cc, x], [0, x, cc], [x, 0, cc], [cc, 0, x]][sec];
    return [Math.round((t[0] + m) * 255), Math.round((t[1] + m) * 255), Math.round((t[2] + m) * 255)];
  };
  const hex = (c: number[]) => "#" + c.map((n) => ("0" + n.toString(16)).slice(-2)).join("");
  const triple = (c: number[]) => `${c[0]} ${c[1]} ${c[2]}`;

  const p = soften(primary), s = soften(secondary), b = soften(base.blue), cy = soften(base.cyan), v = soften(base.violet);
  return {
    "--gold-rgb": triple(p), "--accent-gold": hex(p),
    "--green-rgb": triple(s), "--accent-green": hex(s),
    "--blue-rgb": triple(b), "--blue": hex(b),
    "--cyan-rgb": triple(cy), "--violet-rgb": triple(v),
  };
}

/**
 * Pulls a saved look back inside the admin's limits. Self-contained (also serialised into the init script):
 * it only ever reads the policy's theme list, so a stale policy can never widen what is allowed.
 * hasLook = the person has actually chosen a theme; if not, the role's default theme applies.
 */
export function clampLook(look: Look, pol: RolePolicy | null, hasLook: boolean): Look {
  if (!pol) return look;
  const allowed: string[] = Array.isArray(pol.themes) ? pol.themes : [];
  if (!pol.allowCustomize || !hasLook || allowed.indexOf(look.preset) < 0) {
    const wanted = pol.defaultTheme && PRESET_LOOKS[pol.defaultTheme] ? pol.defaultTheme : "noir";
    return { ...PRESET_LOOKS[wanted], motion: look.motion };
  }
  return look;
}

/** Complete looks by theme id. Named for the inlined init script, which declares its own copy. */
export const PRESET_LOOKS: Record<ThemeId, Look> = THEMES.reduce((acc, t) => {
  acc[t.id] = { preset: t.id, style: t.style, palette: t.palette, vibrancy: t.vibrancy, motion: "on", scene: t.scene, blur: t.blur, depth: t.depth };
  return acc;
}, {} as Record<ThemeId, Look>);

const VAR_NAMES = ["--gold-rgb", "--accent-gold", "--green-rgb", "--accent-green", "--blue-rgb", "--blue", "--cyan-rgb", "--violet-rgb"];

export function readLook(): Look { return readLookRaw().look; }

/** Reads the saved theme. Older saves kept separate style / palette / scene choices: they resolve to the
 *  nearest of the five themes, and everything outside a theme is dropped. */
export function readLookRaw(): { look: Look; has: boolean } {
  const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  try {
    const raw = JSON.parse(localStorage.getItem(LOOK_KEY) || "null");
    if (raw && typeof raw === "object") {
      let preset: ThemeId | null = isThemeId(raw.preset) ? raw.preset : null;
      if (!preset) {
        // legacy save: match the old style (or palette) to the theme designed around it
        const legacy = THEMES.find((t) => t.style === raw.style && t.palette === raw.palette)
          || THEMES.find((t) => t.palette === raw.palette)
          || THEMES.find((t) => t.style === raw.style);
        preset = legacy ? legacy.id : DEFAULT_THEME;
      }
      const look = presetLook(preset);
      return { has: true, look: { ...look, motion: raw.motion === "off" ? "off" : (reduce ? "off" : "on") } };
    }
  } catch {}
  return { has: false, look: { ...DEFAULT_LOOK, motion: reduce ? "off" : "on" } };
}

export function applyLook(look: Look, theme: Mode) {
  const root = document.documentElement;
  const vars = computeLookVars(look, theme, PALETTES);
  for (const n of VAR_NAMES) root.style.removeProperty(n);
  if (vars) for (const [n, val] of Object.entries(vars)) root.style.setProperty(n, val);
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
  root.setAttribute("data-palette", look.palette);
  root.setAttribute("data-motion", look.motion);
  root.setAttribute("data-style", look.style);
  root.setAttribute("data-scene-on", look.scene === "off" ? "0" : "1");
  root.setAttribute("data-blur", look.blur || "soft");
  root.setAttribute("data-depth-mode", look.depth || "subtle");
}

export function saveLook(look: Look) {
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch {}
}

/**
 * Inline script run before first paint: resolves the theme (clamped to the cached admin policy) and applies it,
 * so there is never a flash of the wrong theme, colours or style.
 */
export const APPEARANCE_INIT_SCRIPT = `(function(){try{
var P=${JSON.stringify(PALETTES)},PRESET_LOOKS=${JSON.stringify(PRESET_LOOKS)},MODES=${JSON.stringify(THEME_MODES)},ls=function(k){try{return localStorage.getItem(k)}catch(e){return null}};
var L=null,pc=null,pol=null;try{L=JSON.parse(ls('${LOOK_KEY}')||'null')}catch(e){}try{pc=JSON.parse(ls('${POLICY_KEY}')||'null')}catch(e){}
if(pc&&pc.policy)pol=pc.policy;
var rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var look=L&&PRESET_LOOKS[L.preset]?PRESET_LOOKS[L.preset]:PRESET_LOOKS.noir;
look={preset:look.preset,style:look.style,palette:look.palette,vibrancy:look.vibrancy,scene:look.scene,blur:look.blur,depth:look.depth,motion:L?(L.motion==='off'?'off':'on'):(rm?'off':'on')};
var cl=${clampLook.toString()};look=cl(look,pol,!!L);
var th=MODES[look.preset]||'dark';
var r=document.documentElement;r.setAttribute('data-theme',th);r.style.colorScheme=th;
var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',th==='light'?'#F3F4F7':'#000000');
var f=${computeLookVars.toString()};var v=f(look,th,P);
if(v){for(var n in v){r.style.setProperty(n,v[n])}}
r.setAttribute('data-palette',look.palette);r.setAttribute('data-motion',look.motion);r.setAttribute('data-style',look.style);r.setAttribute('data-scene-on',look.scene==='off'?'0':'1');r.setAttribute('data-blur',look.blur);r.setAttribute('data-depth-mode',look.depth);
var mv=ls('${MASCOT_KEY}');r.setAttribute('data-mascot',mv==='0'?'0':'1');
}catch(e){}})();`;
