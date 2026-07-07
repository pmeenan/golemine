import { readFileSync } from "node:fs";

import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { appName, themeStorageKey } from "../src/lib/constants";

const appShellHeading = "Local backup workspace";

interface ThemeSnapshot {
  bgToken: string;
  colorScheme: string;
  theme: string | null;
}

interface ThemeExpectation {
  bgTone: "dark" | "light";
  colorScheme: string;
  theme: string | null;
}

async function expectAppShell(page: Page) {
  await expect(page).toHaveTitle(appName);
  await expect(page.getByRole("link", { name: appName }).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: appShellHeading })).toBeVisible();
}

async function readThemeSnapshot(page: Page): Promise<ThemeSnapshot> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);

    return {
      bgToken: styles.getPropertyValue("--bg").trim(),
      colorScheme: styles.colorScheme,
      theme: root.getAttribute("data-theme"),
    };
  });
}

function classifyBgToken(bgToken: string) {
  const normalized = bgToken.replace("oklch(.", "oklch(0.");

  if (normalized.startsWith("oklch(0.16 ")) {
    return "dark";
  }

  if (normalized.startsWith("oklch(0.98 ")) {
    return "light";
  }

  throw new Error(`Unexpected --bg token: ${bgToken}`);
}

async function readThemeExpectation(page: Page): Promise<ThemeExpectation> {
  const snapshot = await readThemeSnapshot(page);

  return {
    bgTone: classifyBgToken(snapshot.bgToken),
    colorScheme: snapshot.colorScheme,
    theme: snapshot.theme,
  };
}

function postLoadRequestIsAllowed(request: Request, baseURL: string) {
  const url = new URL(request.url());
  const appUrl = new URL(baseURL);

  if (url.origin !== appUrl.origin) {
    return false;
  }

  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/sw.js") {
    return true;
  }

  if (url.pathname === "/manifest.webmanifest") {
    return true;
  }

  return /^\/(assets\/|workbox-).+\.(css|ico|js|png|svg|wasm|woff2)$/.test(url.pathname);
}

async function waitForServiceWorkerActivation(page: Page) {
  await expect
    .poll(() => page.evaluate(() => "serviceWorker" in navigator))
    .toBe(true);

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active ?? registration.waiting ?? registration.installing;

    if (!worker) {
      throw new Error("Service worker registration has no worker.");
    }

    if (worker.state === "activated") {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error(`Service worker did not activate; current state is ${worker.state}.`));
      }, 10_000);

      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    });
  });
}

async function ensureServiceWorkerControlsPage(page: Page) {
  const isControlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));

  if (isControlled) {
    return;
  }

  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

async function reloadOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);

  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectAppShell(page);
  } finally {
    await context.setOffline(false);
  }
}

test("renders the app shell", async ({ page }) => {
  await page.goto("/");
  await expectAppShell(page);
});

test("runs worker and sqlite diagnostics in the browser", async ({ page }) => {
  await page.goto("/");
  await expectAppShell(page);
  await expect(page.getByRole("heading", { name: "Worker diagnostics" })).toBeVisible();
  await expect(page.getByText("backup-worker round-trip complete.")).toBeVisible();
  await expect(page.getByText("db-worker round-trip complete.")).toBeVisible();
  await expect(page.getByText("media-worker round-trip complete.")).toBeVisible();
  await expect(page.getByText(/SQLite .+ via opfs-sahpool\./)).toBeVisible({
    timeout: 20_000,
  });
});

test("applies persisted system, light, and dark theme preferences", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expectAppShell(page);
  await expect.poll(() => readThemeExpectation(page)).toEqual({
    bgTone: "dark",
    colorScheme: "light dark",
    theme: null,
  });

  await page.evaluate((key) => {
    localStorage.setItem(key, "light");
  }, themeStorageKey);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => readThemeExpectation(page)).toEqual({
    bgTone: "light",
    colorScheme: "light",
    theme: "light",
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate((key) => {
    localStorage.setItem(key, "dark");
  }, themeStorageKey);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => readThemeExpectation(page)).toEqual({
    bgTone: "dark",
    colorScheme: "dark",
    theme: "dark",
  });

  await page.evaluate((key) => {
    localStorage.setItem(key, "system");
  }, themeStorageKey);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => readThemeExpectation(page)).toEqual({
    bgTone: "light",
    colorScheme: "light dark",
    theme: null,
  });
});

function readProductionCsp(): string {
  const headersFile = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const match = /^\s*Content-Security-Policy:\s*(.+)$/im.exec(headersFile);

  if (!match) {
    throw new Error("public/_headers does not declare a Content-Security-Policy header.");
  }

  return match[1].trim();
}

test.describe("production CSP from public/_headers", () => {
  // vite preview does not serve header files, so replay the CSP onto every
  // response ourselves. Service workers are blocked so no response can bypass
  // the route handler, mirroring a static host that serves `_headers`.
  test.use({ serviceWorkers: "block" });

  test("app shell, workers, and sqlite-wasm run under the production CSP", async ({ page }) => {
    const productionCsp = readProductionCsp();
    const cspViolations: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("Content Security Policy")) {
        cspViolations.push(message.text());
      }
    });

    await page.route("**/*", async (route) => {
      const response = await route.fetch();

      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": productionCsp,
        },
      });
    });

    await page.goto("/");
    await expectAppShell(page);
    await expect(page.getByText("backup-worker round-trip complete.")).toBeVisible();
    await expect(page.getByText("db-worker round-trip complete.")).toBeVisible();
    await expect(page.getByText("media-worker round-trip complete.")).toBeVisible();
    await expect(page.getByText(/SQLite .+ via opfs-sahpool\./)).toBeVisible({
      timeout: 20_000,
    });

    expect(cspViolations).toEqual([]);
  });
});

test.describe("network guardrail without service worker mediation", () => {
  test.use({ serviceWorkers: "block" });

  test("blocks unexpected post-load network requests", async ({ page, baseURL }) => {
    if (!baseURL) {
      throw new Error("Playwright baseURL is required for the privacy guardrail.");
    }

    let monitorPostLoad = false;
    const unexpectedRequests: string[] = [];

    await page.route("**/*", async (route) => {
      const request = route.request();

      if (monitorPostLoad && !postLoadRequestIsAllowed(request, baseURL)) {
        unexpectedRequests.push(`${request.method()} ${request.url()}`);
        await route.abort("blockedbyclient");
        return;
      }

      await route.continue();
    });

    await page.goto("/");
    await expectAppShell(page);
    await page.waitForLoadState("networkidle");

    monitorPostLoad = true;
    await page.waitForTimeout(1_000);

    expect(unexpectedRequests).toEqual([]);
  });
});

test("reloads offline after the generated service worker is installed", async ({ context, page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expectAppShell(page);
  await waitForServiceWorkerActivation(page);
  await ensureServiceWorkerControlsPage(page);
  await reloadOffline(context, page);
});
