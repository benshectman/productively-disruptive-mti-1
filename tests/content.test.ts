import { describe, expect, it } from "vitest";
import evidence from "../src/content/evidence.v0.1.json";

describe("evidence content", () => {
  it("preserves the approved story sequence", () => {
    expect(evidence.stages.map((stage) => stage.id)).toEqual([
      "establish",
      "prove",
      "scale",
      "institutionalize"
    ]);
  });

  it("enforces the bounded generation contract", () => {
    expect(Object.values(evidence.generationContract).every(Boolean)).toBe(true);
  });
});
