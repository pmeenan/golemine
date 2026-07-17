/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_APP_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
