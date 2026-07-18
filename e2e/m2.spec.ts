import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  iosMiniBackupExpectedMetadata,
  iosMiniBackupUdid,
  iosMalformedBackupUdid,
} from "./fixtures/ios-mini-backup.mjs";
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
const iosMalformedBackupRoot = path.join(
  fixturesDir,
  "fixtures",
  "generated",
  "ios-malformed-backup",
  iosMalformedBackupUdid,
);

test("ingests the synthetic unencrypted iPhone backup into the derived database", async ({
  page,
}) => {
  await installFixtureDirectoryPicker(page, {
    files: readFixtureFiles(iosMiniBackupRoot),
    rootName: iosMiniBackupUdid,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Mina's iPhone backup" }),
  ).toBeVisible({ timeout: 15_000 });

  const ingestPanel = page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: "Ingest" }),
  });

  await page.getByRole("button", { name: "Ingest messages" }).click();
  await expect(ingestPanel.getByRole("status")).toContainText(
    `Extracted ${String(
      iosMiniBackupExpectedMetadata.counts.normalizedMessages,
    )} messages from ${String(
      iosMiniBackupExpectedMetadata.counts.conversations,
    )} conversations.`,
    { timeout: 30_000 },
  );

  await expect(ingestPanel.getByText("Ingested", { exact: true })).toBeVisible();
  await expect(ingestPanel.getByText("Messages", { exact: true })).toBeVisible();
  await expect(
    ingestPanel.locator('div:has(> dt:text-is("Messages")) > dd'),
  ).toHaveText(String(iosMiniBackupExpectedMetadata.counts.normalizedMessages));
  await expect(ingestPanel.getByText("Warnings", { exact: true })).toBeVisible();
  await expect(
    ingestPanel.locator('div:has(> dt:text-is("Warnings")) > dd'),
  ).toHaveText(String(iosMiniBackupExpectedMetadata.counts.avatarWarnings));
  const rebuildButton = page.getByRole("button", { name: "Rebuild messages" });

  await expect(rebuildButton).toBeVisible();

  await rebuildButton.click();
  await expect(ingestPanel.getByRole("status")).toContainText(
    `Extracted ${String(
      iosMiniBackupExpectedMetadata.counts.normalizedMessages,
    )} messages from ${String(
      iosMiniBackupExpectedMetadata.counts.conversations,
    )} conversations.`,
    { timeout: 30_000 },
  );
  await expect(ingestPanel.getByText("Ingested", { exact: true })).toBeVisible();
  await expect(
    ingestPanel.locator('div:has(> dt:text-is("Messages")) > dd'),
  ).toHaveText(String(iosMiniBackupExpectedMetadata.counts.normalizedMessages));

  const storagePanel = page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: "Derived storage" }),
  });
  await expect(storagePanel.getByText(/\d+(?:\.\d)? (?:KiB|MiB|GiB)/u)).toBeVisible();
  await storagePanel.getByRole("button", { name: "Clear derived data" }).click();
  const clearDialog = page.getByRole("dialog", {
    name: "Clear derived data for Mina's iPhone backup?",
  });
  await clearDialog.getByRole("button", { name: "Clear derived data" }).click();
  await expect(storagePanel.getByRole("status")).toContainText(
    "The source backup was not changed.",
  );
  await expect(storagePanel.getByText("0 bytes", { exact: true })).toBeVisible();
  await expect(ingestPanel.getByText("Not ingested", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ingest messages" })).toBeVisible();
});

test("ingests malformed optional records and exposes the warning count", async ({
  page,
}) => {
  await installFixtureDirectoryPicker(page, {
    files: readFixtureFiles(iosMalformedBackupRoot),
    rootName: iosMalformedBackupUdid,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open backup" }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Synthetic malformed iPhone backup",
    }),
  ).toBeVisible({ timeout: 15_000 });
  const ingestPanel = page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: "Ingest" }),
  });
  await page.getByRole("button", { name: "Ingest messages" }).click();
  await expect(ingestPanel.getByRole("status")).toContainText(
    /Extracted \d+ messages from/u,
    { timeout: 30_000 },
  );
  await expect(ingestPanel.getByText("Ingested", { exact: true })).toBeVisible();
  await expect(
    ingestPanel.locator('div:has(> dt:text-is("Warnings")) > dd'),
  ).toHaveText("4");
});
