import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Golemine",
        short_name: "Golemine",
        description: "Offline phone backup exploration tool.",
        theme_color: "oklch(0.72 0.13 78)",
        background_color: "oklch(0.98 0.003 255)",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,ico,png,svg,webp,woff2,wasm}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: {
        enabled: true,
        type: "module",
      },
    }),
  ],
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
});
