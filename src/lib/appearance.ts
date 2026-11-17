import { z } from "zod";
import { useEffect, useSyncExternalStore } from "react";
import { brandingSchema, type Branding } from "./types";

/**
 * How the app looks: ten themes, a font, the density and corner radius, how much moves, and a
 * workspace's own branding (name, logo, accent colour, default theme). Each person picks their
 * theme; an owner sets the workspace's branding and the theme new members start with.
 */

export interface Theme {
  id: string;
  name: string;
  /** One line on the idea behind it. */
  idea: string;
  dark: boolean;
  /** The moving layer behind the app. */
  ambient: "none" | "grid" | "circuit" | "aurora" | "particles" | "scanlines" | "girih" | "blobs" | "synthwave" | "stream" | "noise";
  font: FontId;
  /** Swatches for the picker: background, surface, accent, second accent, menu. */
  swatch: [string, string, string, string, string];
}

export const THEMES: Theme[] = [
  { id: "blueprint", name: "Blueprint", idea: "The drafting table: cool paper, navy ink and one blueprint blue.", dark: false, ambient: "grid", font: "plex", swatch: ["#f3f5f8", "#ffffff", "#2447d6", "#b7791f", "#16233a"] },
  { id: "circuit", name: "Midnight circuit", idea: "A board at night: signals run along the traces behind your work.", dark: true, ambient: "circuit", font: "inter", swatch: ["#0b1220", "#111a2e", "#22d3ee", "#a3e635", "#070d18"] },
  { id: "aurora", name: "Aurora", idea: "Northern lights over a dark sky, slowly shifting between teal and violet.", dark: true, ambient: "aurora", font: "sora", swatch: ["#0d1022", "#151a33", "#8b5cf6", "#2dd4bf", "#090b19"] },
  { id: "quantum", name: "Quantum field", idea: "Particles drift and link up, like the connections in your estate.", dark: true, ambient: "particles", font: "space", swatch: ["#120a1f", "#1b1030", "#e879f9", "#38bdf8", "#0c0616"] },
  { id: "terminal", name: "Command line", idea: "Green on black with scan lines, for those who live in a terminal.", dark: true, ambient: "scanlines", font: "mono", swatch: ["#050a06", "#0b130d", "#22c55e", "#facc15", "#030604"] },
  { id: "oasis", name: "Digital oasis", idea: "Warm sand and deep teal under a turning geometric star pattern.", dark: false, ambient: "girih", font: "plexArabic", swatch: ["#f7f1e6", "#fffaf2", "#0f766e", "#c2410c", "#123b3a"] },
  { id: "glass", name: "Glass", idea: "Frosted panels over soft colour that drifts behind them.", dark: false, ambient: "blobs", font: "inter", swatch: ["#eef2fb", "#ffffffcc", "#4f46e5", "#ec4899", "#1e1b4b"] },
  { id: "synthwave", name: "Neon grid", idea: "A horizon of neon lines rolling towards you.", dark: true, ambient: "synthwave", font: "space", swatch: ["#140b24", "#1d1033", "#ff3ea5", "#22e4ff", "#0d0618"] },
  { id: "stream", name: "Data stream", idea: "Clean white with data flowing across, for reviews and workshops.", dark: false, ambient: "stream", font: "sora", swatch: ["#f6f9fc", "#ffffff", "#0b7a75", "#2563eb", "#0f2a3d"] },
  { id: "carbon", name: "Carbon", idea: "Graphite and signal orange: high contrast for long sessions and big screens.", dark: true, ambient: "noise", font: "plex", swatch: ["#151618", "#1e2023", "#ff7a1a", "#4ade80", "#0e0f10"] },
];
export const themeById = (id: string | null | undefined) => THEMES.find((t) => t.id === id) ?? THEMES[0];

export const FONTS = {
  plex: { name: "IBM Plex Sans", stack: '"IBM Plex Sans", ui-sans-serif, system-ui, "Segoe UI", sans-serif', load: () => Promise.resolve() },
  inter: { name: "Inter", stack: '"Inter", ui-sans-serif, system-ui, "Segoe UI", sans-serif', load: () => Promise.all([import("@fontsource/inter/400.css"), import("@fontsource/inter/500.css"), import("@fontsource/inter/600.css")]) },
  sora: { name: "Sora", stack: '"Sora", ui-sans-serif, system-ui, "Segoe UI", sans-serif', load: () => Promise.all([import("@fontsource/sora/400.css"), import("@fontsource/sora/600.css")]) },
  space: { name: "Space Grotesk", stack: '"Space Grotesk", ui-sans-serif, system-ui, "Segoe UI", sans-serif', load: () => Promise.all([import("@fontsource/space-grotesk/400.css"), import("@fontsource/space-grotesk/600.css")]) },
  mono: { name: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace', load: () => Promise.all([import("@fontsource/jetbrains-mono/400.css"), import("@fontsource/jetbrains-mono/600.css")]) },
  plexArabic: { name: "IBM Plex Sans Arabic", stack: '"IBM Plex Sans", "IBM Plex Sans Arabic", ui-sans-serif, system-ui, sans-serif', load: () => Promise.all([import("@fontsource/ibm-plex-sans-arabic/400.css"), import("@fontsource/ibm-plex-sans-arabic/600.css")]) },
  cairo: { name: "Cairo", stack: '"Cairo", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', load: () => Promise.all([import("@fontsource/cairo/400.css"), import("@fontsource/cairo/600.css")]) },
  tajawal: { name: "Tajawal", stack: '"Tajawal", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif', load: () => Promise.all([import("@fontsource/tajawal/400.css"), import("@fontsource/tajawal/500.css")]) },
} as const;
export type FontId = keyof typeof FONTS;
export const FONT_IDS = Object.keys(FONTS) as FontId[];

/* ---------- each person's choice, kept in this browser ---------- */

export const prefsSchema = z.object({
  /** null follows the workspace's theme. */
  theme: z.string().nullable().default(null),
  /** null follows the theme's font. */
  font: z.string().nullable().default(null),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  radius: z.enum(["sharp", "soft", "round"]).default("soft"),
  motion: z.enum(["full", "calm", "off"]).default("full"),
});
export type Prefs = z.infer<typeof prefsSchema>;

const PREFS_KEY = "archone.appearance";
const listeners = new Set<() => void>();
let cached: Prefs | null = null;
export function readPrefs(): Prefs {
  if (cached) return cached;
  try {
    cached = prefsSchema.parse(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}"));
  } catch {
    cached = prefsSchema.parse({});
  }
  return cached;
}
export function setPrefs(patch: Partial<Prefs>): void {
  cached = prefsSchema.parse({ ...readPrefs(), ...patch });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(cached));
  } catch {
    // Not kept for next time; it still applies now.
  }
  listeners.forEach((l) => l());
}
export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readPrefs,
    readPrefs,
  );
}

/* ---------- the workspace's branding, set by an owner ---------- */

export { brandingSchema };
export type { Branding };

export const DEFAULT_APP_NAME = "ArchONE";

/** What is in effect: the person's choice, else the workspace's, else the default. */
export function effective(prefs: Prefs, branding: Branding | undefined) {
  const theme = themeById(prefs.theme ?? branding?.theme);
  const fontId = ((prefs.font ?? branding?.font) || theme.font) as FontId;
  const font = FONTS[fontId] ? fontId : theme.font;
  return { theme, font, accent: branding?.accent ?? "", appName: branding?.appName?.trim() || DEFAULT_APP_NAME, logo: branding?.logo ?? "" };
}

/** A colour a step darker or lighter, for the deep and soft shades of an accent. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Puts the appearance on the page: theme, font, accent, density, radius, motion and scale. */
export function useApplyAppearance(branding: Branding | undefined): ReturnType<typeof effective> {
  const prefs = usePrefs();
  const now = effective(prefs, branding);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = now.theme.id;
    root.dataset.motion = prefs.motion;
    root.dataset.density = prefs.density;
    root.dataset.radius = prefs.radius;
    root.style.colorScheme = now.theme.dark ? "dark" : "light";
    void FONTS[now.font].load().then(() => root.style.setProperty("--font-sans", FONTS[now.font].stack));
    if (now.accent) {
      root.style.setProperty("--color-blueprint", now.accent);
      root.style.setProperty("--color-blueprint-deep", shade(now.accent, -0.22));
      root.style.setProperty("--color-blueprint-soft", now.theme.dark ? `color-mix(in srgb, ${now.accent} 22%, transparent)` : shade(now.accent, 0.88));
    } else {
      for (const v of ["--color-blueprint", "--color-blueprint-deep", "--color-blueprint-soft"]) root.style.removeProperty(v);
    }
  }, [now.theme.id, now.theme.dark, now.font, now.accent, prefs.motion, prefs.density, prefs.radius]);
  useEffect(() => {
    document.title = now.appName === DEFAULT_APP_NAME ? "ArchONE Diagrams" : now.appName;
  }, [now.appName]);
  return now;
}
