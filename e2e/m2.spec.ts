import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  iosMiniBackupExpectedMetadata,
  iosMiniBackupUdid,
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

  await page.getByRole("button", { name: "Ingest messages" }).click();
  await expect(page.getByRole("status")).toContainText(
    `Extracted ${String(
      iosMiniBackupExpectedMetadata.counts.normalizedMessages,
    )} messages from ${String(
      iosMiniBackupExpectedMetadata.counts.conversations,
    )} conversations.`,
    { timeout: 30_000 },
  );

  const ingestPanel = page.locator("section").filter({
    has: page.getByRole("heading", { level: 2, name: "Ingest" }),
  });

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
  await expect(page.getByRole("status")).toContainText(
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
});
