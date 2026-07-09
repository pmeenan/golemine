import { describe, expect, it } from "vitest";

import { classifyServiceKind } from "./service-kind";

describe("classifyServiceKind", () => {
  it("classifies iMessage case-insensitively", () => {
    expect(classifyServiceKind("iMessage")).toBe("imessage");
    expect(classifyServiceKind("IMESSAGE")).toBe("imessage");
    expect(classifyServiceKind("imessage")).toBe("imessage");
    expect(classifyServiceKind("  iMessage  ")).toBe("imessage");
  });

  it("classifies the SMS token family case-insensitively", () => {
    expect(classifyServiceKind("SMS")).toBe("sms-family");
    expect(classifyServiceKind("sms")).toBe("sms-family");
    expect(classifyServiceKind("MMS")).toBe("sms-family");
    expect(classifyServiceKind("mms")).toBe("sms-family");
    expect(classifyServiceKind("RCS")).toBe("sms-family");
    expect(classifyServiceKind("rcs")).toBe("sms-family");
  });

  it("maps missing and non-exact tokens to unknown", () => {
    expect(classifyServiceKind(undefined)).toBe("unknown");
    expect(classifyServiceKind("")).toBe("unknown");
    expect(classifyServiceKind("   ")).toBe("unknown");
    expect(classifyServiceKind("SMS-forwarded")).toBe("unknown");
    expect(classifyServiceKind("imessage2")).toBe("unknown");
    expect(classifyServiceKind("Signal")).toBe("unknown");
  });
});
