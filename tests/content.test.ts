import { describe, expect, it } from "vitest";
import { contentPacket, evidenceById, publicEvidenceView, validateContentReferences } from "../src/content/content";
import { buildDeepDiveNarrative } from "../src/shared/narrative";

describe("approved content integrity", () => {
  it("resolves every evidence, topic, proposition, source, and story-beat reference", () => {
    expect(validateContentReferences()).toEqual([]);
  });
  it("uses only valid visibility metadata", () => {
    expect(contentPacket.sources.every((source) => ["shareable", "knowledge_only"].includes(source.visibility))).toBe(true);
  });
  it("builds all four story beats from valid evidence", () => {
    const beats = buildDeepDiveNarrative();
    expect(beats.map((beat) => beat.label)).toEqual(["Establish", "Prove", "Scale", "Institutionalize"]);
    expect(beats.every((beat) => beat.evidenceRefs.every((id) => evidenceById.has(id)))).toBe(true);
  });
  it("never includes knowledge-only source metadata in client-visible evidence", () => {
    const visible = JSON.stringify(publicEvidenceView(contentPacket.evidence[0]));
    expect(visible).not.toContain("knowledge_only");
    expect(visible).not.toContain("SRC-");
    expect(visible).not.toContain(contentPacket.sources[0].title);
  });
  it("preserves approved attribution unchanged", () => {
    for (const record of contentPacket.evidence) expect(publicEvidenceView(record).attribution).toBe(record.attribution);
  });
});

