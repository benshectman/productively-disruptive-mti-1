import { describe, expect, it } from "vitest";
import { GenerateRequestSchema, GenerateResponseSchema } from "../src/shared/contracts";

describe("generation contracts", () => {
  it("accepts a bounded request", () => {
    expect(GenerateRequestSchema.parse({ message: "Explain the transformation." }).message)
      .toBe("Explain the transformation.");
  });

  it("rejects empty requests", () => {
    expect(() => GenerateRequestSchema.parse({ message: "  " })).toThrow();
  });

  it("requires exactly one response outcome", () => {
    expect(GenerateResponseSchema.parse({ answer: "Grounded answer" }).answer)
      .toBe("Grounded answer");
    expect(() => GenerateResponseSchema.parse({ answer: "x", error: "y" })).toThrow();
  });
});
