import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app/App";
import "./styles/tokens.css";
import "./styles/global.css";

registerSW({ immediate: true });

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Golemine root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
