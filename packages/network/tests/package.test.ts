import { describe, expect, it } from "vitest";

import { NETWORK_PACKAGE_PLACEHOLDER } from "../src";

describe("@kbm-remote/network", () => {
  it("exports its placeholder while implementations arrive in M2/M4", () => {
    expect(NETWORK_PACKAGE_PLACEHOLDER).toBe(true);
  });
});
