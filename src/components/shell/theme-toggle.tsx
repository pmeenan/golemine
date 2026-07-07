import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "../../lib/cn";
import {
  applyThemePreference,
  persistThemePreference,
  readStoredThemePreference,
  type ThemePreference,
} from "../../lib/theme";

interface ThemeOption {
  icon: LucideIcon;
  label: string;
  value: ThemePreference;
}

const themeOptions: readonly ThemeOption[] = [
  { icon: Monitor, label: "System", value: "system" },
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
];

export function ThemeToggle() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredThemePreference(),
  );

  useEffect(() => {
    applyThemePreference(themePreference);
  }, [themePreference]);

  const selectTheme = useCallback((nextThemePreference: ThemePreference) => {
    persistThemePreference(nextThemePreference);
    setThemePreference(nextThemePreference);
  }, []);

  return (
    <div
      aria-label="Theme"
      className="inline-flex items-center rounded-md border border-border bg-surface-sunken p-0.5"
      role="group"
    >
      {themeOptions.map(({ icon: Icon, label, value }) => {
        const isSelected = value === themePreference;

        return (
          <button
            aria-label={`Use ${label.toLowerCase()} theme`}
            aria-pressed={isSelected}
            className={cn(
              "inline-flex size-[var(--control-height-sm)] items-center justify-center rounded-sm text-text-tertiary hover:bg-surface-raised hover:text-text",
              isSelected && "bg-accent-subtle text-accent-text",
            )}
            key={value}
            onClick={() => {
              selectTheme(value);
            }}
            title={`${label} theme`}
            type="button"
          >
            <Icon aria-hidden="true" className="size-4" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
