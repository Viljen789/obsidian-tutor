/**
 * Light / dark theme. The colour tokens already exist in index.css (`.dark`) and
 * Tailwind runs in `darkMode: "class"` mode, so theming is purely a matter of
 * which class sits on <html>. First paint is handled by the inline script in
 * index.html (no flash); this module is the app-side source of truth: it reads
 * the class the boot script set, lets components toggle it, and persists the
 * choice. A tiny external store keeps every toggle (header, settings) in sync.
 */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "tutor-theme";

function readDomTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

let current: Theme = readDomTheme();
const listeners = new Set<() => void>();

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  current = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage may be unavailable (private mode) — the class still applies */
  }
  listeners.forEach((l) => l());
}

export function toggleTheme(): void {
  setTheme(current === "dark" ? "light" : "dark");
}

/**
 * Subscribe a component to the current theme. Returns the theme plus a `toggle`
 * and a direct `setTheme`, all driving the same shared store.
 */
export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
  return { theme, toggle: toggleTheme, setTheme };
}
