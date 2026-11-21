import { useSyncExternalStore } from "react";

// The theme is a three-way preference: system (follows the OS setting, live), light or dark. It is
// remembered on the device; index.html applies it before the first paint (same key, same rule).

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_KEY = "kompass.theme";
const CHROME = { light: "#fafafa", dark: "#171717" } as const;

/** A stored value to a preference; anything unknown is "system". */
export function parsePreference(raw: unknown): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** The theme in force for a preference and the system setting. */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

const query = () => matchMedia("(prefers-color-scheme: dark)");

function readStored(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

let preference: ThemePreference = readStored();
const listeners = new Set<() => void>();

function apply() {
  const theme = resolveTheme(preference, query().matches);
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  // the browser chrome: the media-keyed metas follow the system; a forced theme overrides both
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = meta.media.includes("dark") ? "dark" : "light";
    meta.content = CHROME[preference === "system" ? own : theme];
  }
}

function emit() {
  apply();
  for (const l of listeners) l();
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    // storage blocked: the choice holds for this session only
  }
  emit();
}

function subscribe(onChange: () => void) {
  const mq = query();
  const system = () => emit();
  mq.addEventListener("change", system);
  listeners.add(onChange);
  return () => {
    mq.removeEventListener("change", system);
    listeners.delete(onChange);
  };
}

/** The stored choice (system / light / dark) and its setter. */
export function useThemePreference(): [ThemePreference, (p: ThemePreference) => void] {
  const p = useSyncExternalStore(subscribe, () => preference);
  return [p, setThemePreference];
}

/** "dark" or "light": the theme in force; re-renders when the choice or the system setting changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => resolveTheme(preference, query().matches));
}
