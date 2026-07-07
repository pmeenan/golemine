import { describe, expect, it } from "vitest";
import { appName, appVersion, derivedDbVersion, themeStorageKey } from "./constants";

describe("app constants", () => {
  it("exposes the M0 baseline constants", () => {
    expect(appName).toBe("Golemine");
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(derivedDbVersion).toBeGreaterThan(0);
    expect(themeStorageKey).toBe("golemine-theme");
  });
});
