import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import approvedCorpus from "../src/content/approved/ben-facts.v1.json";
import { approvedPointsLabel, buildEvidencePresentation, evidencePointsLabel } from "../src/shared/evidence-presentation";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const evidenceCss = readFileSync(new URL("../src/evidence-dialog.css", import.meta.url), "utf8");

describe("evidence presentation", () => {
  it.each([1, 3, 9])("resolves and counts %i approved evidence points", (count) => {
    const refs = approvedCorpus.facts.slice(0, count).map((item) => item.id);
    const result = buildEvidencePresentation(refs, "A narrative block");
    expect(result.contextLabel).toBe("A narrative block");
    expect(result.items).toHaveLength(count);
    expect(result.items.map((item) => item.id)).toEqual(refs);
  });

  it("deduplicates references and omits unresolved references", () => {
    const id = approvedCorpus.facts[0].id;
    expect(buildEvidencePresentation([id, id, "E-999"], "Context").items.map((item) => item.id)).toEqual([id]);
  });

  it("preserves approved claims and attribution without exposing source metadata", () => {
    const approved = approvedCorpus.facts[0];
    const visible = buildEvidencePresentation([approved.id], "Context").items[0];
    expect(visible.claim).toBe(approved.claim);
    expect(visible.attribution).toBe(approved.attribution);
    expect(visible).not.toHaveProperty("sources");
    expect(JSON.stringify(visible)).not.toContain("knowledge_only");
  });

  it("uses readable singular and plural labels", () => {
    expect(approvedPointsLabel(1)).toBe("1 approved point");
    expect(approvedPointsLabel(9)).toBe("9 approved points");
    expect(evidencePointsLabel(1, "approved")).toBe("1 approved point");
    expect(evidencePointsLabel(9, "approved")).toBe("9 approved points");
  });

  it("keeps Astryx dialog content inset from every edge", () => {
    expect(appSource).toContain("className=\"evidence-dialog\"");
    expect(appSource).toContain("padding={4} purpose=\"info\"");
    expect(evidenceCss).toContain("padding: 1.25rem 0 .5rem");
  });

  it("does not animate Astryx scroll-lock restoration on close", () => {
    expect(evidenceCss).toMatch(/html\s*\{\s*scroll-behavior:\s*auto;/);
  });
});

