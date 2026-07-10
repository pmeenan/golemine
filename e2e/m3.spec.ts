import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Locator } from "@playwright/test";

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
  await expect(page.getByTestId("m4-search-panel")).toBeVisible();
  await expect(page.getByTestId("message-details-pane")).toHaveCount(0);
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
  await expect(timeline.getByRole("img", { name: "ore-map.png" })).toBeVisible({
    timeout: 15_000,
  });
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
  await expect(detail.locator('dt:text-is("Row") + dd')).toHaveText("4");
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
  await expect(
    page.getByRole("dialog", { name: "Message details" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Close message details" }).click();
  await expect(page.getByTestId("message-details-pane")).toHaveCount(0);

  await timeline.hover();
  await page.mouse.wheel(0, 900);
  await expect(timeline.getByText("WAL-only message after the last checkpoint.")).toBeVisible();

  const searchBox = page.getByRole("searchbox", { name: "Search messages" });
  const searchForm = page.getByTestId("m4-search-form");
  const searchButton = searchForm.getByRole("button", {
    exact: true,
    name: "Search",
  });

  await searchBox.fill("   ");
  await expect(searchButton).toBeDisabled();
  await searchBox.fill("the");
  await searchButton.click();
  const searchThreads = page.getByTestId("search-thread-list");
  const results = page.getByTestId("m4-search-results");

  await expect(searchThreads).toBeVisible();
  const fieldNotesThread = searchThreads.getByRole("button", {
    name: /Field Notes/,
  });
  const rowanThread = searchThreads.getByRole("button", { name: /Rowan Vale/ });

  await expect(searchThreads.getByRole("button").nth(0)).toContainText(
    "Field Notes",
  );
  await expect(fieldNotesThread.getByLabel("2 search hits")).toBeVisible();
  await expect(rowanThread.getByLabel("2 search hits")).toBeVisible();
  await expect(results.locator('[data-testid^="search-result-"]')).toHaveCount(4);
  await expect(
    page.getByTestId("search-results-pane").getByText("4", { exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ height: 768, width: 1024 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);

  await fieldNotesThread.click();
  await expect(results.locator('[data-testid^="search-result-"]')).toHaveCount(2);
  await expect(results.getByTestId("search-result-6")).toBeVisible();
  await expect(results.getByTestId("search-result-4")).toBeVisible();
  await expect(results.getByTestId("search-result-1")).toHaveCount(0);

  const timelineScroller = timeline.locator('[data-virtuoso-scroller="true"]');
  const fieldResult = results.getByTestId("search-result-4");
  const fieldTarget = page.getByTestId("message-4");

  await expect(fieldTarget).toHaveAttribute("role", "button");
  await expect(fieldTarget).toHaveAttribute("tabindex", "0");
  await timelineScroller.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Timeline scroller is not an HTML element.");
    }
    element.style.height = "12rem";
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => isVerticalCenterWithin(timelineScroller, fieldTarget))
    .toBe(false);
  await fieldResult.click();

  const overlayDialog = page.getByRole("dialog", { name: "Message details" });

  await expect(overlayDialog).toBeVisible();
  await expect(page.locator("#root")).toHaveAttribute("inert", "");
  await expect
    .poll(() =>
      overlayDialog.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    )
    .toBe(true);

  await searchBox.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Search input is not an HTML input element.");
    }
    element.click();
    element.focus();
  });
  await expect(searchBox).not.toBeFocused();
  await expect
    .poll(() =>
      overlayDialog.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(overlayDialog).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(fieldResult).toBeFocused();
  await expect
    .poll(() => isVerticalCenterWithin(timelineScroller, fieldTarget))
    .toBe(true);
  await timelineScroller.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.style.removeProperty("height");
    }
  });

  await page.setViewportSize({ height: 768, width: 1536 });
  await fieldResult.click();
  await expect(page.getByTestId("message-details-pane")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Message details" }),
  ).toHaveCount(0);
  await timelineScroller.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Timeline scroller is not an HTML element.");
    }
    element.style.height = "12rem";
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => isVerticalCenterWithin(timelineScroller, fieldTarget))
    .toBe(false);

  await fieldResult.click();
  await expect
    .poll(() => isVerticalCenterWithin(timelineScroller, fieldTarget))
    .toBe(true);
  await page.getByRole("button", { name: "Close message details" }).click();
  await timelineScroller.evaluate((element) => {
    if (element instanceof HTMLElement) {
      element.style.removeProperty("height");
    }
  });
  await page.setViewportSize({ height: 768, width: 1024 });

  await page
    .getByRole("button", { name: "Show results from all threads" })
    .click();
  await expect(results.locator('[data-testid^="search-result-"]')).toHaveCount(4);

  await results.getByTestId("search-result-1").click();
  await expect(page).toHaveURL(/\/messages\?conversation=.*&message=.*/u);
  expect(new URL(page.url()).pathname).toBe(
    `/backup/${encodeURIComponent(iosMiniBackupUdid)}/messages`,
  );
  await expect(page.getByTestId("message-1")).toContainText(
    "Did you find the brass gear?",
  );

  const directMessage = iosMiniBackupExpectedMessages.find(
    (message) => message.sourceRowId === 1,
  );

  if (directMessage === undefined) {
    throw new Error("Fixture message 1 metadata is missing.");
  }

  await expect(page.getByTestId("m3-message-detail")).toContainText(
    directMessage.guid,
  );
  await expect(
    page.getByRole("dialog", { name: "Message details" }),
  ).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId("message-details-pane")).toHaveCount(0);
  await expect(results.locator('[data-testid^="search-result-"]')).toHaveCount(4);
  await expect(
    page.getByRole("button", { name: "Show results from all threads" }),
  ).toBeDisabled();

  await page.goBack();
  await expect(page.getByTestId("search-results-pane")).toContainText(
    "Results: Field Notes",
  );
  await expect(results.locator('[data-testid^="search-result-"]')).toHaveCount(2);
  await expect(results.getByTestId("search-result-1")).toHaveCount(0);

  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Message details" }),
  ).toBeVisible();
  await expect(results.getByTestId("search-result-4")).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.goForward();
  await page.goForward();
  await page.goForward();
  await expect(page.getByTestId("m3-message-detail")).toContainText(
    directMessage.guid,
  );
  await page.getByRole("button", { name: "Close message details" }).click();
  await expect(page.getByTestId("message-details-pane")).toHaveCount(0);
  await expect(page.getByTestId("message-1")).toBeVisible();
  await expect(results).toBeVisible();
  await expect(searchBox).toHaveValue("the");

  const dateRangeTrigger = page.getByTestId("date-range-trigger");
  await expect(dateRangeTrigger).toHaveAccessibleName("Date range Any date");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await dateRangeTrigger.click();
  const dateRangeDialog = page.getByRole("dialog", {
    name: "Choose a date range",
  });
  await expect(dateRangeDialog).toBeVisible();
  await expectDatePickerTheme(dateRangeDialog, "dark");
  await expectDatePickerYearBounds(dateRangeDialog);
  await page.keyboard.press("Escape");
  await expect(dateRangeDialog).toHaveCount(0);
  await expect(dateRangeTrigger).toBeFocused();

  await page.getByRole("button", { name: "Use light theme" }).click();
  await dateRangeTrigger.click();
  await expectDatePickerTheme(dateRangeDialog, "light");
  const applyDatesButton = dateRangeDialog.getByRole("button", {
    name: "Apply dates",
  });
  const rangeStart = dateRangeDialog.locator(
    '[data-day="2026-06-30"] button',
  );
  const rangeEnd = dateRangeDialog.locator(
    '[data-day="2026-07-01"] button',
  );

  await rangeStart.click();
  await expect(dateRangeDialog).toContainText("Select an end date");
  await expect(applyDatesButton).toBeDisabled();
  await rangeEnd.click();
  await expect(applyDatesButton).toBeEnabled();
  await applyDatesButton.click();
  await expect(dateRangeTrigger).toHaveAccessibleName(
    "Date range Jun 30, 2026 – Jul 1, 2026",
  );

  await dateRangeTrigger.click();
  const singleDay = dateRangeDialog.locator(
    '[data-day="2026-06-30"]:not([data-outside]) button',
  );
  await singleDay.click();
  await singleDay.click();
  await applyDatesButton.click();
  await expect(dateRangeTrigger).toHaveAccessibleName("Date range Jun 30, 2026");
  await searchButton.click();
  await expect(searchThreads).toContainText("No conversations matched this search.");

  await page.getByRole("button", { exact: true, name: "Clear" }).click();
  await expect(dateRangeTrigger).toHaveAccessibleName("Date range Any date");
  await searchButton.click();
  await expect(results.locator('[data-testid^="search-result-"]')).toHaveCount(4);

  await searchBox.fill("synthetic");
  await page.getByLabel("Has attachment").check();
  await searchButton.click();

  await expect(searchThreads.getByRole("button", { name: /Field Notes/ })).toBeVisible();
  await expect(searchThreads.getByRole("button", { name: /Rowan Vale/ })).toHaveCount(0);
  await expect(results.getByTestId("search-result-4")).toContainText(
    "Attaching the synthetic ore map.",
  );
  await expect(results.getByText("1 attachment")).toBeVisible();

  await searchForm.getByRole("button", { exact: true, name: "Reset" }).click();
  await expect(page.getByTestId("search-results-pane")).toHaveCount(0);
  await expect(page.getByTestId("search-thread-list")).toHaveCount(0);
  await expect(page.getByTestId("m3-conversation-list")).toBeVisible();
  await expect(searchBox).toHaveValue("");
  await expect(page.getByLabel("Has attachment")).not.toBeChecked();
  await expect(page.getByRole("button", { name: /Field Notes/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Rowan Vale/ })).toBeVisible();
  await expect(page.getByTestId("message-details-pane")).toHaveCount(0);
});

function titleCase(value: string): string {
  return value.slice(0, 1).toLocaleUpperCase() + value.slice(1);
}

async function expectDatePickerTheme(
  dialog: Locator,
  expectedColorScheme: "dark" | "light",
): Promise<void> {
  const dropdowns = dialog.locator("[data-date-picker-dropdown]");
  await expect(dropdowns).toHaveCount(4);
  const palette = await dropdowns.first().evaluate((element) => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Date picker dropdown is not a select element.");
    }

    const firstOption = element.options.item(0);
    const selectedOption = element.selectedOptions.item(0);

    if (firstOption === null || selectedOption === null) {
      throw new Error("Date picker dropdown options are missing.");
    }

    const rootStyle = getComputedStyle(document.documentElement);
    const selectStyle = getComputedStyle(element);
    const optionStyle = getComputedStyle(firstOption);
    const selectedOptionStyle = getComputedStyle(selectedOption);
    const token = (name: string) => rootStyle.getPropertyValue(name).trim();
    const normalizeColor = (color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (context === null) {
        throw new Error("Canvas color conversion is unavailable.");
      }

      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).join(",");
    };
    const contrast = (foreground: string, background: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (context === null) {
        throw new Error("Canvas color conversion is unavailable.");
      }

      const luminance = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        const linearize = (channel: number) => {
          const value = channel / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        };

        return (
          0.2126 * linearize(red) +
          0.7152 * linearize(green) +
          0.0722 * linearize(blue)
        );
      };

      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    };

    const surfaceRaised = token("--surface-raised");
    const text = token("--text");
    const textSecondary = token("--text-secondary");
    const accent = token("--accent");
    const accentForeground = token("--accent-foreground");
    const accentSubtle = token("--accent-subtle");
    const accentText = token("--accent-text");

    return {
      colorScheme: selectStyle.colorScheme,
      contrasts: {
        endpoint: contrast(accentForeground, accent),
        primary: contrast(text, surfaceRaised),
        range: contrast(text, accentSubtle),
        secondary: contrast(textSecondary, surfaceRaised),
        today: contrast(accentText, surfaceRaised),
      },
      expected: {
        accent: normalizeColor(accent),
        accentForeground: normalizeColor(accentForeground),
        surfaceRaised: normalizeColor(surfaceRaised),
        text: normalizeColor(text),
      },
      option: {
        background: normalizeColor(optionStyle.backgroundColor),
        color: normalizeColor(optionStyle.color),
      },
      select: {
        background: normalizeColor(selectStyle.backgroundColor),
        color: normalizeColor(selectStyle.color),
      },
      selectedOption: {
        background: normalizeColor(selectedOptionStyle.backgroundColor),
        color: normalizeColor(selectedOptionStyle.color),
      },
    };
  });

  expect(palette.colorScheme).toBe(expectedColorScheme);
  expect(palette.select).toEqual({
    background: palette.expected.surfaceRaised,
    color: palette.expected.text,
  });
  expect(palette.option).toEqual({
    background: palette.expected.surfaceRaised,
    color: palette.expected.text,
  });
  expect(palette.selectedOption).toEqual({
    background: palette.expected.accent,
    color: palette.expected.accentForeground,
  });
  for (const ratio of Object.values(palette.contrasts)) {
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
}

async function expectDatePickerYearBounds(dialog: Locator): Promise<void> {
  const state = await dialog.evaluate((element) => {
    const yearDropdowns = Array.from(
      element.querySelectorAll<HTMLSelectElement>(
        'select[aria-label="Choose the Year"]',
      ),
    );

    return {
      currentYear: new Date().getFullYear(),
      yearOptions: yearDropdowns.map((dropdown) =>
        Array.from(dropdown.options, (option) => option.value),
      ),
    };
  });
  const expectedYears = Array.from(
    { length: state.currentYear - 2007 + 1 },
    (_, index) => String(state.currentYear - index),
  );

  expect(state.yearOptions).toHaveLength(2);
  for (const options of state.yearOptions) {
    expect(options).toEqual(expectedYears);
  }

  const yearDropdowns = dialog.locator('select[aria-label="Choose the Year"]');
  const monthDropdowns = dialog.locator('select[aria-label="Choose the Month"]');
  await expect(yearDropdowns).toHaveCount(2);
  await expect(monthDropdowns).toHaveCount(2);
  const firstYearDropdown = yearDropdowns.nth(0);
  const firstMonthDropdown = monthDropdowns.nth(0);

  await firstYearDropdown.selectOption("2007");
  await firstMonthDropdown.selectOption("0");
  await expect(
    dialog.locator('[data-day="2006-12-31"] button'),
  ).toHaveCount(0);

  await firstYearDropdown.selectOption(String(state.currentYear));
  await firstMonthDropdown.selectOption("11");
  const followingYear = String(state.currentYear + 1);
  await expect(
    dialog.locator(`[data-day="${followingYear}-01-01"] button`),
  ).toHaveCount(0);
}

async function isVerticalCenterWithin(
  container: Locator,
  target: Locator,
): Promise<boolean> {
  const [containerBox, targetBox] = await Promise.all([
    container.boundingBox(),
    target.boundingBox(),
  ]);

  if (containerBox === null || targetBox === null) {
    return false;
  }

  const targetCenter = targetBox.y + targetBox.height / 2;

  return (
    targetCenter >= containerBox.y &&
    targetCenter <= containerBox.y + containerBox.height
  );
}
