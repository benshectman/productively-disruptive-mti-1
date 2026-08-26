import { describe, expect, it } from "vitest";
import { assembleNarrative, selectEvidence, validateNarrativeEvidence } from "../src/shared/narrative";

describe("deterministic topic selection", () => {
  it("creates a balanced four-section narrative with no topics", () => {
    const narrative = assembleNarrative([]);
    expect(narrative.sections).toHaveLength(4);
    expect(validateNarrativeEvidence(narrative)).toBe(true);
  });
  it("Design Leadership changes the strongest evidence emphasis", () => {
    const balanced = selectEvidence([]).map((item) => item.id);
    const leadership = selectEvidence(["T-001"]).map((item) => item.id);
    expect(leadership).not.toEqual(balanced);
    expect(leadership.slice(0, 5)).toContain("E-007");
  });
  it("Systems Thinking emphasizes operating-model evidence", () => {
    const systems = selectEvidence(["T-002"]).slice(0, 6).map((item) => item.id);
    expect(systems).toEqual(expect.arrayContaining(["E-004", "E-005", "E-006"]));
  });
  it("multiple topics remain bounded and valid", () => {
    const narrative = assembleNarrative(["T-001", "T-002"]);
    expect(narrative.sections.length).toBeGreaterThanOrEqual(3);
    expect(validateNarrativeEvidence(narrative)).toBe(true);
  });
});

