import { describe, expect, it } from "vitest";

import { AUTH_PACKAGE_PLACEHOLDER } from "../src";

describe("@kbm-remote/auth", () => {
  it("exports its placeholder while implementations arrive in M1/M3", () => {
    expect(AUTH_PACKAGE_PLACEHOLDER).toBe(true);
  });
});
