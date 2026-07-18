import { readFileSync } from "node:fs";

import { expect, test, type Page, type Request } from "@playwright/test";
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

  return /^\/(assets\/|workbox-).+\.(css|ico|js|png|svg|wasm|webp|woff2)$/.test(url.pathname);
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

test("renders the app shell", async ({ page }) => {
  await page.goto("/");
  await expectAppShell(page);
});

test("supports skip navigation, route focus, and distinct document titles", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  await page
    .locator("#main-content")
    .getByRole("link", { name: "iPhone guide" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "iPhone backup guide" }),
  ).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page).toHaveTitle(`iPhone backup guide — ${appName}`);
});

test("keeps public-route landmarks, headings, images, and controls accessible", async ({
  page,
}) => {
  for (const route of ["/", "/guide/iphone", "/guide/android", "/missing"]) {
    await page.goto(route);
    await expect(page.locator("h1")).toHaveCount(1);

    const issues = await page.evaluate(() => {
      const results: string[] = [];
      const ids = new Set<string>();

      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>("[id]"),
      )) {
        if (ids.has(element.id)) {
          results.push(`duplicate id: ${element.id}`);
        }
        ids.add(element.id);
      }

      if (document.querySelectorAll("main").length !== 1) {
        results.push("page must contain exactly one main landmark");
      }

      for (const image of Array.from(document.querySelectorAll("img"))) {
        if (!image.hasAttribute("alt")) {
          results.push(`image without alt: ${image.getAttribute("src") ?? "unknown"}`);
        }
      }

      const accessibleName = (element: HTMLElement): string => {
        const labelledBy = element.getAttribute("aria-labelledby");
        const referenced = labelledBy
          ?.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");

        return (
          element.getAttribute("aria-label") ??
          referenced ??
          element.getAttribute("title") ??
          element.innerText
        ).trim();
      };

      for (const control of Array.from(
        document.querySelectorAll<HTMLElement>(
          "button, a[href], input, select, textarea",
        ),
      )) {
        if (control.closest('[aria-hidden="true"]')) {
          continue;
        }

        if (
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
        ) {
          if ((control.labels?.length ?? 0) === 0 && accessibleName(control) === "") {
            results.push(`unlabelled form control: ${control.tagName.toLowerCase()}`);
          }
        } else if (accessibleName(control) === "") {
          results.push(`unnamed control: ${control.tagName.toLowerCase()}`);
        }
      }

      let previousLevel = 0;
      for (const heading of Array.from(
        document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
      )) {
        const level = Number(heading.tagName.slice(1));
        if (previousLevel > 0 && level > previousLevel + 1) {
          results.push(
            `heading level jumps from ${String(previousLevel)} to ${String(level)}`,
          );
        }
        previousLevel = level;
      }

      return results;
    });

    expect(issues, route).toEqual([]);
  }
});

test("publishes the synchronized favicon and install icon set", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("type", "image/svg+xml");

  const iconSet = await page.evaluate(async () => {
    const manifestResponse = await fetch("/manifest.webmanifest");
    const manifest = (await manifestResponse.json()) as {
      icons?: {
        purpose?: string;
        sizes?: string;
        src?: string;
        type?: string;
      }[];
    };
    const icons = manifest.icons ?? [];

    return Promise.all(
      icons.map(async (icon) => {
        const response = await fetch(icon.src ?? "");
        const bitmap = await createImageBitmap(await response.blob());
        const result = {
          ...icon,
          height: bitmap.height,
          width: bitmap.width,
        };
        bitmap.close();
        return result;
      }),
    );
  });

  expect(iconSet).toEqual([
    {
      height: 192,
      purpose: "any",
      sizes: "192x192",
      src: "/pwa-icon-192.png",
      type: "image/png",
      width: 192,
    },
    {
      height: 512,
      purpose: "any",
      sizes: "512x512",
      src: "/pwa-icon-512.png",
      type: "image/png",
      width: 512,
    },
    {
      height: 512,
      purpose: "maskable",
      sizes: "512x512",
      src: "/pwa-icon-maskable-512.png",
      type: "image/png",
      width: 512,
    },
  ]);
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

test("serves every app request from Workbox after install with the network offline", async ({
  baseURL,
  context,
  page,
}) => {
  if (!baseURL) {
    throw new Error("Playwright baseURL is required for the offline audit.");
  }

  const appOrigin = new URL(baseURL).origin;
  await page.goto("/", { waitUntil: "networkidle" });
  await expectAppShell(page);
  await waitForServiceWorkerActivation(page);
  await ensureServiceWorkerControlsPage(page);

  // Remove the ordinary HTTP cache while preserving CacheStorage so this
  // audit proves the installed Workbox precache is the only successful
  // response source once Chrome's network is disabled.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await page.close();
  await context.setOffline(true);

  const offlinePage = await context.newPage();
  const externalRequests: string[] = [];
  const failedRequests: string[] = [];
  const nonServiceWorkerResponses: string[] = [];

  offlinePage.on("request", (request) => {
    const url = new URL(request.url());

    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.origin !== appOrigin) {
        externalRequests.push(request.url());
      }
    }
  });
  offlinePage.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? "unknown"})`);
  });
  offlinePage.on("response", (response) => {
    const url = new URL(response.url());

    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !response.fromServiceWorker()
    ) {
      nonServiceWorkerResponses.push(response.url());
    }
  });

  try {
    await offlinePage.goto("/", { waitUntil: "domcontentloaded" });
    await expectAppShell(offlinePage);
    await expect(
      offlinePage.getByText(/SQLite .+ via opfs-sahpool\./),
    ).toBeVisible({ timeout: 20_000 });

    await offlinePage.goto("/guide/iphone", { waitUntil: "domcontentloaded" });
    await expect(
      offlinePage.getByRole("heading", { level: 1, name: "iPhone backup guide" }),
    ).toBeVisible();

    for (const tone of ["light", "dark"] as const) {
      await offlinePage.getByRole("button", { name: `Use ${tone} theme` }).click();

      for (const assetName of [
        "guide-open-backup",
        "guide-find-backup",
        "guide-encrypted-backup",
      ]) {
        const image = offlinePage.locator(`img[src*="${assetName}-${tone}"]`);

        await expect
          .poll(() =>
            image.evaluate(
              (element) => (element as HTMLImageElement).naturalWidth,
            ),
          )
          .toBeGreaterThan(0);
      }
    }

    await offlinePage.goto("/guide/android", { waitUntil: "domcontentloaded" });
    await expect(
      offlinePage.getByRole("heading", { level: 1, name: "Android backup guide" }),
    ).toBeVisible();
  } finally {
    await offlinePage.close();
    await context.setOffline(false);
  }

  expect(externalRequests).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(nonServiceWorkerResponses).toEqual([]);
});
