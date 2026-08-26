import { describe, expect, it } from "vitest";
import { contentPacket } from "../src/content/content";
import { approvedPointsLabel, buildEvidencePresentation } from "../src/shared/evidence-presentation";

describe("evidence presentation", () => {
  it.each([1, 3, 9])("resolves and counts %i approved evidence points", (count) => {
    const refs = contentPacket.evidence.slice(0, count).map((item) => item.id);
    const result = buildEvidencePresentation(refs, "A narrative block");
    expect(result.contextLabel).toBe("A narrative block");
    expect(result.items).toHaveLength(count);
    expect(result.items.map((item) => item.id)).toEqual(refs);
  });

  it("deduplicates references and omits unresolved references", () => {
    const id = contentPacket.evidence[0].id;
    expect(buildEvidencePresentation([id, id, "E-999"], "Context").items.map((item) => item.id)).toEqual([id]);
  });

  it("preserves approved claims and attribution without exposing source metadata", () => {
    const approved = contentPacket.evidence[0];
    const visible = buildEvidencePresentation([approved.id], "Context").items[0];
    expect(visible.claim).toBe(approved.claim);
    expect(visible.attribution).toBe(approved.attribution);
    expect(visible).not.toHaveProperty("sources");
    expect(JSON.stringify(visible)).not.toContain("knowledge_only");
  });

  it("uses readable singular and plural labels", () => {
    expect(approvedPointsLabel(1)).toBe("1 approved point");
    expect(approvedPointsLabel(9)).toBe("9 approved points");
  });
});
