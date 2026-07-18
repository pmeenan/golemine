import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  iosMiniBackupExpectedMessages,
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

test("builds and prepares a source-verified printable report", async ({ page }) => {
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
  await expect(ingestPanel.getByRole("status")).toContainText("Extracted 5 messages", {
    timeout: 30_000,
  });
  await page.getByRole("link", { name: /Messages/u }).click();
  await page.getByRole("button", { name: /Field Notes/u }).click();

  const attachmentMessage = page.getByTestId("message-4");
  await expect(attachmentMessage).toContainText("Attaching the synthetic ore map.");
  await attachmentMessage
    .locator("..")
    .getByRole("button", { name: "Add or remove message from reports" })
    .click();

  const picker = page.getByTestId("report-picker-dialog");
  await expect(picker).toBeVisible();
  await picker.getByLabel("New report name").fill("Exhibit A");
  await picker.getByRole("button", { name: "Create report" }).click();
  await expect(picker.getByRole("checkbox", { name: /Exhibit A/u })).toBeChecked();
  await picker.getByRole("button", { name: "Close report picker" }).click();

  const searchBox = page.getByRole("searchbox", { name: "Search messages" });
  await searchBox.fill("brass gear");
  await page
    .getByTestId("m4-search-form")
    .getByRole("button", { exact: true, name: "Search" })
    .click();
  const searchResult = page.getByTestId("search-result-1");
  await expect(searchResult).toContainText("brass gear");
  await searchResult
    .getByRole("button", { name: "Add or remove message from reports" })
    .click();
  await picker.getByRole("checkbox", { name: /Exhibit A/u }).check();
  await expect(picker.getByText("2 selected messages")).toBeVisible();
  await picker.getByRole("link", { name: "Open report Exhibit A" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Exhibit A" })).toBeVisible();
  await expect(page.getByText("2 items", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Report title").fill("Exhibit A — gear exchange");
  await page.getByLabel("Matter").fill("Example v. Sample");
  await page.getByLabel("Preparer").fill("Pat Example");
  await page.getByLabel("Displayed timezone").selectOption("America/New_York");
  await page.getByLabel("Item note").first().fill("Attachment preserved with the selected message.");
  await page.getByRole("button", { name: "Prepare print view" }).click();

  const printView = page.getByTestId("report-print-view");
  await expect(printView).toBeVisible();
  await expect(printView).toContainText("Exhibit A — gear exchange");
  await expect(printView).toContainText("Example v. Sample");
  await expect(printView).toContainText("America/New_York");
  await expect(printView).toContainText("Attaching the synthetic ore map.");
  await expect(printView).toContainText("Did you find the brass gear?");
  const transcript = page.getByTestId("report-message-transcript");
  const metadata = page.getByTestId("report-message-metadata");
  await expect(transcript.locator(".report-message-number")).toHaveText(["1", "2"]);
  await expect(metadata).toContainText("Message 1");
  await expect(metadata).toContainText("Attachment preserved with the selected message.");
  await expect(metadata).toContainText(
    iosMiniBackupExpectedMessages.find((message) => message.sourceRowId === 4)
      ?.rawAppleNanoseconds ?? "missing fixture timestamp",
  );
  await expect(transcript).not.toContainText(
    iosMiniBackupExpectedMessages.find((message) => message.sourceRowId === 4)
      ?.rawAppleNanoseconds ?? "missing fixture timestamp",
  );
  expect(await page.evaluate(() => {
    const transcriptElement = document.querySelector('[data-testid="report-message-transcript"]');
    const metadataElement = document.querySelector('[data-testid="report-message-metadata"]');
    return transcriptElement !== null && metadataElement !== null && Boolean(transcriptElement.compareDocumentPosition(metadataElement) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  const appendix = page.getByTestId("report-provenance-appendix");
  await expect(appendix).toContainText("sms.db plaintext SHA-256");
  await expect(appendix).toContainText("Plaintext SHA-256:");
  await expect(appendix).toContainText("Source folder");
  await expect(printView.getByRole("img", { name: "ore-map.png" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(printView.locator(".report-message-bubble img")).toHaveAttribute("alt", "ore-map.png");

  const printButton = page.getByRole("button", { name: "Print to PDF" });
  await expect(printButton).toBeEnabled({ timeout: 15_000 });
  await page.emulateMedia({ colorScheme: "dark", media: "print" });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const documentElement = document.querySelector<HTMLElement>(
          ".report-print-document",
        );
        const toolbar = document.querySelector<HTMLElement>(
          ".report-print-toolbar",
        );
        const bubble = document.querySelector<HTMLElement>(
          ".report-message-bubble",
        );

        if (documentElement === null || toolbar === null || bubble === null) {
          throw new Error("The report print elements were not rendered.");
        }

        const documentStyle = getComputedStyle(documentElement);
        const toolbarStyle = getComputedStyle(toolbar);
        const bubbleStyle = getComputedStyle(bubble);
        return {
          breakInside: bubbleStyle.breakInside,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          printColorAdjust: documentStyle.printColorAdjust,
          toolbarDisplay: toolbarStyle.display,
        };
      }),
    )
    .toEqual({
      breakInside: "avoid",
      colorScheme: "light",
      printColorAdjust: "exact",
      toolbarDisplay: "none",
    });
  await page.emulateMedia({ colorScheme: "dark", media: "screen" });
  await page.evaluate(() => {
    Object.defineProperty(window, "print", {
      configurable: true,
      value: () => {
        document.documentElement.dataset.printInvoked = "true";
      },
    });
  });
  await printButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-print-invoked", "true");

  // The saved report is reachable through the reports list route (the
  // backup overview's Reports tile links here).
  await page.goto(`/backup/${iosMiniBackupUdid}/reports`);
  const savedReportLink = page.getByRole("link", {
    name: /Exhibit A — gear exchange/u,
  });
  await expect(savedReportLink).toBeVisible();
  await expect(savedReportLink).toContainText("2 items");
  await savedReportLink.click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Exhibit A — gear exchange" }),
  ).toBeVisible();
});
