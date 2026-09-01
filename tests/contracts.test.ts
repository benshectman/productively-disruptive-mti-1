import { describe, expect, it } from "vitest";
import { GenerateRequestSchema, NarrativeSchema } from "../src/shared/contracts";
import { assembleNarrative } from "../src/shared/narrative";

describe("configuration and narrative contracts", () => {
  it("accepts the locked renderer and approved topics", () => {
    expect(GenerateRequestSchema.parse({ designSystem: "astryx", theme: "neutral", topics: ["T-001", "T-004"] }).topics).toHaveLength(2);
  });
  it.each([
    { designSystem: "fake", theme: "neutral", topics: [] },
    { designSystem: "astryx", theme: "fake", topics: [] },
    { designSystem: "astryx", theme: "neutral", topics: ["T-999"] },
    { designSystem: "astryx", theme: "neutral", topics: ["T-001", "T-001"] }
  ])("rejects invalid visitor configuration", (value) => expect(GenerateRequestSchema.safeParse(value).success).toBe(false));
  it("validates semantic narrative rather than markup", () => {
    expect(NarrativeSchema.parse(assembleNarrative([])).sections).toHaveLength(4);
    expect(NarrativeSchema.safeParse({ sections: [{ html: "<h1>unsafe</h1>" }] }).success).toBe(false);
  });
});

