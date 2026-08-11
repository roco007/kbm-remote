import { describe, expect, it } from "vitest";

import { FrameType, isValidFrameType } from "../src";

describe("FrameType registry", () => {
  it("exposes all v1.0 type discriminators from the Protocol Specification §4.1", () => {
    expect(FrameType.Hello).toBe(0x01);
    expect(FrameType.MouseMove).toBe(0x40);
    expect(FrameType.ClipboardSync).toBe(0x70);
    expect(FrameType.Disconnect).toBe(0xd0);
    expect(Object.keys(FrameType).length).toBe(38);
  });

  it("recognizes valid discriminators", () => {
    expect(isValidFrameType(FrameType.Ping)).toBe(true);
    expect(isValidFrameType(0xff)).toBe(false);
  });
});
