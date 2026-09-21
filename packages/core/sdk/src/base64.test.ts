import { describe, expect, it } from "@effect/vitest";

import { normalizeBase64 } from "./base64";

describe("normalizeBase64", () => {
  it("maps unpadded Gmail-style base64url onto the padded standard alphabet", () => {
    expect(normalizeBase64("SGk_Cj4-Cg", "base64url")).toBe("SGk/Cj4+Cg==");
  });

  it("restores padding for standard base64", () => {
    expect(normalizeBase64("YQ", "base64")).toBe("YQ==");
  });

  it("leaves already-padded standard base64 unchanged", () => {
    expect(normalizeBase64("YSxiCjEsMgo=", "base64")).toBe("YSxiCjEsMgo=");
  });

  it("does not rewrite -/_ when the encoding is standard base64", () => {
    expect(normalizeBase64("SGk_Cj4-Cg", "base64")).toBe("SGk_Cj4-Cg==");
  });

  it("strips whitespace before padding", () => {
    expect(normalizeBase64("YQ==\n", "base64")).toBe("YQ==");
  });
});
