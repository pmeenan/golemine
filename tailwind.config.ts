import forms from "@tailwindcss/forms";
import type { Config } from "tailwindcss";

const config = {
  darkMode: ["class", "[data-theme='dark']"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-raised": "var(--surface-raised)",
        "surface-sunken": "var(--surface-sunken)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        text: "var(--text)",
        "text-secondary": "var(--text-secondary)",
        "text-tertiary": "var(--text-tertiary)",
        accent: "var(--accent)",
        "accent-foreground": "var(--accent-foreground)",
        "accent-subtle": "var(--accent-subtle)",
        "accent-text": "var(--accent-text)",
        danger: "var(--danger)",
        "danger-foreground": "var(--danger-foreground)",
        "danger-subtle": "var(--danger-subtle)",
        success: "var(--success)",
        warning: "var(--warning)",
        info: "var(--info)",
        "bubble-foreground": "var(--bubble-foreground)",
        "avatar-foreground": "var(--avatar-foreground)",
      },
      fontFamily: {
        sans: ["Inter Variable", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono Variable", "JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        display: ["var(--font-size-display)", { lineHeight: "var(--line-height-display)", fontWeight: "600" }],
        title: ["var(--font-size-title)", { lineHeight: "var(--line-height-title)", fontWeight: "600" }],
        heading: ["var(--font-size-heading)", { lineHeight: "var(--line-height-heading)", fontWeight: "600" }],
        body: ["var(--font-size-body)", { lineHeight: "var(--line-height-body)" }],
        caption: ["var(--font-size-caption)", { lineHeight: "var(--line-height-caption)" }],
        micro: ["var(--font-size-micro)", { lineHeight: "var(--line-height-micro)", fontWeight: "500", letterSpacing: "0.02em" }],
      },
      spacing: {
        "0.5": "var(--space-2)",
        "1": "var(--space-4)",
        "1.5": "var(--space-6)",
        "2": "var(--space-8)",
        "3": "var(--space-12)",
        "4": "var(--space-16)",
        "5": "var(--space-20)",
        "6": "var(--space-24)",
        "8": "var(--space-32)",
        "10": "var(--space-40)",
        "12": "var(--space-48)",
        "16": "var(--space-64)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        bubble: "var(--radius-bubble)",
        full: "var(--radius-full)",
      },
      boxShadow: {
        1: "var(--shadow-1)",
        2: "var(--shadow-2)",
        3: "var(--shadow-3)",
      },
      transitionDuration: {
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        "in-out": "var(--ease-in-out)",
      },
    },
  },
  plugins: [forms],
} satisfies Config;

export default config;
