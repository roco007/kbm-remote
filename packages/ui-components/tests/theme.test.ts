import { describe, expect, it } from "vitest";

import { darkTheme, lightTheme } from "../src";

describe("@kbm-remote/ui-components theme", () => {
  it("defines matching light/dark token shapes", () => {
    expect(Object.keys(lightTheme)).toEqual(Object.keys(darkTheme));
  });

  it("uses distinct accents between themes", () => {
    expect(lightTheme.accent).not.toBe(darkTheme.accent);
  });
});
