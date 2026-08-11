import { describe, expect, it } from "vitest";

import { INPUT_PROVIDER_PLACEHOLDER } from "../src";

describe("@kbm-remote/input-provider", () => {
  it("exports its placeholder while providers arrive in M3", () => {
    expect(INPUT_PROVIDER_PLACEHOLDER).toBe(true);
  });
});
