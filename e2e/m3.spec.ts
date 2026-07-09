import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  iosMiniBackupExpectedMessages,
  iosMiniBackupExpectedMetadata,
  iosMiniBackupExpectedReactions,
  iosMiniBackupUdid,
} from "./fixtures/ios-mini-backup.mjs";
import {
  installFixtureDirectoryPicker,
  readFixtureFiles,
} from "./support/fixture-directory-picker";

test.setTimeout(60_000);

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
const iosMiniBackupRoot = path.join(
  fixturesDir,
  "fixtures",
  "generated",
  "ios-mini-backup",
  iosMiniBackupUdid,
);

test("browses and searches ingested messages from the synthetic iPhone backup", async ({
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

  await page.getByRole("link", { name: /Messages/ }).click();
  await expect(page.getByTestId("m3-conversation-list")).toBeVisible();
  await expect(page.getByRole("button", { name: /Field Notes/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Rowan Vale/ })).toBeVisible();

  await page.setViewportSize({ height: 768, width: 1024 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.setViewportSize({ height: 720, width: 1280 });

  await page.getByRole("button", { name: /Field Notes/ }).click();
  const timeline = page.getByTestId("m3-message-timeline");

  await expect(timeline.getByText("Typedstream body from Niko.")).toBeVisible();
  await expect(timeline.getByText("Attaching the synthetic ore map.")).toBeVisible();
  await expect(timeline.getByText("ore-map.png")).toBeVisible();
  await expect(
    timeline.getByText(
      `${titleCase(iosMiniBackupExpectedReactions[0].kind)} by Rowan Vale`,
    ),
  ).toBeVisible();

  await timeline.getByText("Attaching the synthetic ore map.").click();
  const detail = page.getByTestId("m3-message-detail");
  const messageFour = iosMiniBackupExpectedMessages.find(
    (message) => message.sourceRowId === 4,
  );

  if (messageFour === undefined) {
    throw new Error("Fixture message 4 metadata is missing.");
  }

  await expect(detail.getByText(messageFour.guid)).toBeVisible();
  await expect(detail.locator('div:has(> dt:text-is("Source row id")) > dd')).toHaveText("4");
  await expect(detail.getByText(messageFour.rawAppleNanoseconds)).toBeVisible();
  await expect(detail.getByText("MediaDomain")).toBeVisible();
  await expect(
    detail.getByText(
      iosMiniBackupExpectedMetadata.sourceFiles.attachment.relativePath,
    ),
  ).toBeVisible();
  await expect(
    detail.getByText(iosMiniBackupExpectedMetadata.sourceFiles.attachment.guid),
  ).toBeVisible();

  await timeline.hover();
  await page.mouse.wheel(0, 900);
  await expect(timeline.getByText("WAL-only message after the last checkpoint.")).toBeVisible();

  await page.goto(`/backup/${encodeURIComponent(iosMiniBackupUdid)}/search`);
  await page.getByLabel("Search messages").fill("brass");
  await page.getByRole("button", { name: "Search" }).click();
  const results = page.getByTestId("m3-search-results");

  await expect(results.getByRole("heading", { name: "Rowan Vale" })).toBeVisible();
  await expect(results.getByText("brass")).toBeVisible();
  await results.getByRole("link", { name: "Open in messages" }).click();
  await expect(page).toHaveURL(/\/messages\?conversation=.*&message=.*/u);
  await expect(page.getByText("Did you find the brass gear?")).toBeVisible();

  await page.goto(`/backup/${encodeURIComponent(iosMiniBackupUdid)}/search`);
  await page.getByLabel("Search messages").fill("synthetic");
  await page.getByLabel("Has attachment").check();
  await page.getByRole("button", { name: "Search" }).click();

  await expect(
    page.getByTestId("m3-search-results").getByRole("heading", { name: "Field Notes" }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("m3-search-results")
      .getByText("Attaching the synthetic ore map."),
  ).toBeVisible();
  await expect(page.getByTestId("m3-search-results").getByText("1 attachment")).toBeVisible();
});

function titleCase(value: string): string {
  return value.slice(0, 1).toLocaleUpperCase() + value.slice(1);
}
