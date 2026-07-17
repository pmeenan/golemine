import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { appName } from "../src/lib/constants";
import {
  derivedDataOpfsAppDirectoryName,
  derivedDataOpfsBackupsDirectoryName,
} from "../src/lib/recents";
import { iosMiniBackupUdid } from "./fixtures/ios-mini-backup.mjs";
import {
  installFixtureDirectoryPicker,
  readFixtureFiles,
} from "./support/fixture-directory-picker";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const iosMiniBackupRoot = path.join(
  fixturesDir,
  "fixtures",
  "generated",
  "ios-mini-backup",
  iosMiniBackupUdid,
);

const derivedDataPath = {
  appDirectoryName: derivedDataOpfsAppDirectoryName,
  backupsDirectoryName: derivedDataOpfsBackupsDirectoryName,
};

test("blocks workspace routes without required Chrome APIs while guides remain accessible", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "showDirectoryPicker");

    if ("FileSystemFileHandle" in window) {
      Reflect.deleteProperty(
        FileSystemFileHandle.prototype,
        "createSyncAccessHandle",
      );
    }

    if ("DataTransferItem" in window) {
      Reflect.deleteProperty(
        DataTransferItem.prototype,
        "getAsFileSystemHandle",
      );
    }

    const storagePrototype = Object.getPrototypeOf(navigator.storage) as {
      getDirectory?: unknown;
    };

    Reflect.deleteProperty(storagePrototype, "getDirectory");
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Chrome is required for this workspace",
    }),
  ).toBeVisible();
  await expect(page.getByText("Open local backup folders")).toBeVisible();
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expectIllustrationTheme(page, "gate", "light");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expectIllustrationTheme(page, "gate", "dark");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("[data-illustrated-section]")).toHaveCSS(
    "display",
    "block",
  );
  await page.emulateMedia({ media: "screen" });

  await page.goto("/guide/iphone");
  await expect(
    page.getByRole("heading", { level: 1, name: "iPhone backup guide" }),
  ).toBeVisible();
  await expect(
    page.getByText("The backup can be made on any Mac or Windows computer."),
  ).toBeVisible();
  await expect(
    page.getByText("Open Finder and select the iPhone in the sidebar."),
  ).toBeVisible();
  await expect(
    page.getByText("Chrome may not be allowed to read directly from the Library folder."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Apple: back up with your Mac" }),
  ).toBeVisible();
});

test("decorative illustrations follow manual light and dark themes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await page.getByRole("button", { name: "Use light theme" }).click();

  const dropTarget = page.locator("[data-backup-drop-target]");
  const dropOverlay = page.locator("[data-backup-drop-overlay]");

  await expectIllustrationTheme(page, "landing", "light");
  await expect(dropOverlay).toHaveAttribute("aria-hidden", "true");
  await expectIllustrationLoaded(page, "drop-target", "light");

  await dropTarget.dispatchEvent("dragover");
  await expect(dropOverlay).not.toHaveAttribute("aria-hidden", "true");
  await expect(page.getByText("Drop to open this backup")).toBeVisible();
  await expectIllustrationTheme(page, "drop-target", "light");

  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expectIllustrationTheme(page, "landing", "dark");
  await expectIllustrationTheme(page, "drop-target", "dark");

  await page.getByRole("button", { name: "Use system theme" }).click();
  await expectIllustrationTheme(page, "landing", "light");
  await expectIllustrationTheme(page, "drop-target", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectIllustrationTheme(page, "landing", "dark");
  await expectIllustrationTheme(page, "drop-target", "dark");

  await page.goto("/guide/iphone");
  for (const assetName of [
    "guide-open-backup",
    "guide-find-backup",
    "guide-encrypted-backup",
  ]) {
    await expectIllustrationTheme(page, assetName, "dark");
  }

  await page.emulateMedia({ colorScheme: "light" });
  for (const assetName of [
    "guide-open-backup",
    "guide-find-backup",
    "guide-encrypted-backup",
  ]) {
    await expectIllustrationTheme(page, assetName, "light");
  }

  await page.emulateMedia({ media: "print" });
  await expect(page.locator("[data-illustrated-section]")).toHaveCount(3);
  await expect
    .poll(() =>
      page
        .locator("[data-illustrated-section]")
        .evaluateAll((sections) =>
          sections.map((section) => getComputedStyle(section).display),
        ),
    )
    .toEqual(["block", "block", "block"]);
});

test("opens a synthetic iPhone backup, persists recents, renames, and removes derived data", async ({
  page,
}) => {
  await installFixtureDirectoryPicker(page, {
    files: readFixtureFiles(iosMiniBackupRoot),
    rootName: iosMiniBackupUdid,
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Local backup workspace" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Mina's iPhone backup" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("C39SYNTH0001")).toBeVisible();
  await expect(page.getByText("+15555550123")).toBeVisible();

  await createDerivedDataSentinel(page, iosMiniBackupUdid);
  await page.getByRole("link", { name: appName }).click();

  await expect(page.getByRole("heading", { name: "Recent backups" })).toBeVisible();
  await expect(page.getByText("Mina's iPhone backup")).toBeVisible();

  await page.getByRole("button", { name: "Rename backup" }).click();
  await page.getByLabel("Backup name").fill("Evidence iPhone");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Evidence iPhone" })).toBeVisible();

  await page.getByRole("button", { exact: true, name: "Open" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Evidence iPhone" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: appName }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Local backup workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Evidence iPhone" })).toBeVisible();

  await page.getByRole("button", { name: "Remove recent backup" }).click();
  await page.getByRole("button", { name: "Remove Evidence iPhone" }).click();
  await expect(page.getByText("No recent backups are stored.")).toBeVisible();
  await expect.poll(() => derivedDataDirectoryExists(page, iosMiniBackupUdid)).toBe(false);
});

test("confirms before replacing a different backup snapshot for the same device", async ({
  page,
}) => {
  await installFixtureDirectoryPicker(page, {
    files: readFixtureFiles(iosMiniBackupRoot),
    replacementRootName: `${iosMiniBackupUdid}-newer-copy`,
    rootName: iosMiniBackupUdid,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Mina's iPhone backup" }),
  ).toBeVisible({ timeout: 15_000 });
  await createDerivedDataSentinel(page, iosMiniBackupUdid);
  await page.getByRole("link", { name: appName }).click();

  // The picker fixture uses a second source folder after the first selection,
  // producing a distinct directory identity with the same detected device UDID.
  await page.getByRole("button", { name: "Open backup" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Replace existing backup?",
  });

  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(
    dialog.getByText(/permanently removes the existing local ingest/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Keep existing" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText(/Kept the existing backup for Mina's iPhone/),
  ).toBeVisible();
  await expect.poll(() => derivedDataDirectoryExists(page, iosMiniBackupUdid)).toBe(true);

  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Replace backup" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Mina's iPhone backup" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Not ingested")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ingest messages" })).toBeVisible();
  await expect.poll(() => derivedDataDirectoryExists(page, iosMiniBackupUdid)).toBe(false);
});

async function createDerivedDataSentinel(page: Page, backupId: string): Promise<void> {
  await page.evaluate(
    async ({ appDirectoryName, backupsDirectoryName, id }) => {
      const root = await navigator.storage.getDirectory();
      const appDirectory = await root.getDirectoryHandle(appDirectoryName, {
        create: true,
      });
      const backupsDirectory = await appDirectory.getDirectoryHandle(
        backupsDirectoryName,
        { create: true },
      );
      const backupDirectory = await backupsDirectory.getDirectoryHandle(id, {
        create: true,
      });
      const sentinel = await backupDirectory.getFileHandle("sentinel.txt", {
        create: true,
      });
      const writable = await sentinel.createWritable();

      await writable.write("synthetic derived data");
      await writable.close();
    },
    { ...derivedDataPath, id: backupId },
  );
}

async function derivedDataDirectoryExists(
  page: Page,
  backupId: string,
): Promise<boolean> {
  return page.evaluate(
    async ({ appDirectoryName, backupsDirectoryName, id }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const appDirectory = await root.getDirectoryHandle(appDirectoryName, {
          create: false,
        });
        const backupsDirectory = await appDirectory.getDirectoryHandle(
          backupsDirectoryName,
          { create: false },
        );

        await backupsDirectory.getDirectoryHandle(id, { create: false });
        return true;
      } catch (cause) {
        if (cause instanceof Error && cause.name === "NotFoundError") {
          return false;
        }

        throw cause;
      }
    },
    { ...derivedDataPath, id: backupId },
  );
}

type IllustrationTone = "dark" | "light";

async function expectIllustrationTheme(
  page: Page,
  assetName: string,
  tone: IllustrationTone,
): Promise<void> {
  const lightVariant = page.locator(`img[src*="${assetName}-light"]`);
  const darkVariant = page.locator(`img[src*="${assetName}-dark"]`);

  await expect(lightVariant).toHaveAttribute("alt", "");
  await expect(darkVariant).toHaveAttribute("alt", "");

  if (tone === "light") {
    await expect(lightVariant).toBeVisible();
    await expect(darkVariant).toBeHidden();
    return;
  }

  await expect(lightVariant).toBeHidden();
  await expect(darkVariant).toBeVisible();
}

async function expectIllustrationLoaded(
  page: Page,
  assetName: string,
  tone: IllustrationTone,
): Promise<void> {
  const image = page.locator(`img[src*="${assetName}-${tone}"]`);

  await expect(image).toHaveAttribute("alt", "");
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
}
