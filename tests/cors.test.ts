import { afterEach, describe, expect, it } from "vitest";

import { allowedOrigin } from "../netlify/functions/generate";

const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

afterEach(() => {
  if (originalAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
});

describe("generation origin policy", () => {
  it("allows the deploy's own browser origin", () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(allowedOrigin(
      "https://develop--portfolio-gpt.netlify.app",
      "develop--portfolio-gpt.netlify.app",
    )).toBe("https://develop--portfolio-gpt.netlify.app");
  });

  it("continues to allow explicitly configured cross-origin clients", () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:8888,https://review.example.com";
    expect(allowedOrigin("https://review.example.com", "portfolio-gpt.netlify.app"))
      .toBe("https://review.example.com");
  });

  it("rejects unrelated and malformed origins", () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(allowedOrigin("https://attacker.example", "develop--portfolio-gpt.netlify.app")).toBe("");
    expect(allowedOrigin("not a URL", "develop--portfolio-gpt.netlify.app")).toBe("");
  });
});
