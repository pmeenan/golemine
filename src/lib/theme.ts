import { themeStorageKey } from "./constants";

export const themePreferences = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof themePreferences)[number];

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readStoredThemePreference(): ThemePreference {
  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    return isThemePreference(storedTheme) ? storedTheme : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  if (preference === "system") {
    delete document.documentElement.dataset.theme;
    return;
  }

  document.documentElement.dataset.theme = preference;
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(themeStorageKey, preference);
  } catch {
    // The in-memory theme still applies when localStorage is unavailable.
  }

  applyThemePreference(preference);
}
