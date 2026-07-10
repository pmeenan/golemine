import { describe, expect, it } from "vitest";

import { derivePasscodeKey } from "./index";

function hex(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function toHex(value: Uint8Array): string {
  return [...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("derivePasscodeKey", () => {
  const salt = hex("00112233445566778899aabbccddeeff");
  const password = "pässword🔐";

  it("matches a legacy PBKDF2-SHA1 vector", async () => {
    const events: string[] = [];
    const result = await derivePasscodeKey(
      password,
      { salt, iterations: 4096 },
      (event) => {
        events.push(
          `${event.stage}:${event.state}:${String(event.completedStages)}/${String(event.totalStages)}`,
        );
      },
    );

    expect(toHex(result)).toBe(
      "90794ed3b428ac848852083620a66ea1fac0677ef0d2cc5f684f03a2afeb8b35",
    );
    expect(events).toEqual([
      "passcode:starting:0/1",
      "passcode:complete:1/1",
    ]);
  });

  it("matches the iOS 10.2+ SHA-256 then SHA-1 vector", async () => {
    const events: string[] = [];
    const result = await derivePasscodeKey(
      password,
      {
        salt,
        iterations: 4096,
        doubleProtectionSalt: hex("ffeeddccbbaa99887766554433221100"),
        doubleProtectionIterations: 12_345,
      },
      (event) => {
        events.push(
          `${event.stage}:${event.state}:${String(event.completedStages)}/${String(event.totalStages)}`,
        );
      },
    );

    expect(toHex(result)).toBe(
      "deaac1f6c787b82763e5dcb6ddaee2c9193659e6881fc8e514e1f24a4148c303",
    );
    expect(events).toEqual([
      "double-protection:starting:0/2",
      "double-protection:complete:1/2",
      "passcode:starting:1/2",
      "passcode:complete:2/2",
    ]);
  });

  it("rejects hostile iteration counts before invoking WebCrypto", async () => {
    await expect(
      derivePasscodeKey(password, { salt, iterations: 50_000_001 }),
    ).rejects.toMatchObject({
      code: "unsupported-keybag",
    });
    await expect(
      derivePasscodeKey(password, {
        salt,
        iterations: 1,
        doubleProtectionSalt: salt,
      }),
    ).rejects.toMatchObject({
      code: "malformed-keybag",
    });
  });
});
