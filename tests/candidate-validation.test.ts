import { afterEach, describe, expect, it } from "vitest";
import { generateNarrative } from "../netlify/functions/generate";
import {
  assembleCandidateNarrative,
  candidateValidationIds,
  publicCandidateEvidence
} from "../netlify/functions/candidate-validation";
import { assembleNarrative } from "../src/shared/narrative";
import type { TopicId } from "../src/shared/contracts";

afterEach(() => {
  delete process.env.BENFACTS_VALIDATION_MODE;
  delete process.env.OPENAI_API_KEY;
});

describe("temporary candidate BenFacts validation mode", () => {
  it("returns to the approved corpus when the temporary mode is explicitly disabled", async () => {
    process.env.BENFACTS_VALIDATION_MODE = "approved";
    const narrative = await generateNarrative(["T-001"]);
    expect(narrative).toEqual(assembleNarrative(["T-001"]));
    expect(narrative.grounding).toBe("approved");
    expect(narrative.sections.flatMap((section) => section.evidenceRefs).every((id) => id.startsWith("E-"))).toBe(true);
  });

  it("builds a complete deterministic experience without OpenAI when enabled", async () => {
    const narrative = await generateNarrative([]);
    expect(narrative.mode).toBe("deterministic");
    expect(narrative.grounding).toBe("candidate_validation");
    expect(narrative.sections).toHaveLength(4);
    expect(narrative.sections.flatMap((section) => section.evidenceRefs).every((id) => candidateValidationIds.has(id))).toBe(true);
  });

  it("materially changes candidate selection for each visitor topic", () => {
    const topics: TopicId[] = ["T-001", "T-002", "T-003", "T-004"];
    const selections = topics.map((topic) => assembleCandidateNarrative([topic]).sections.flatMap((section) => section.evidenceRefs));
    expect(new Set(selections.map((selection) => selection.join("|"))).size).toBe(4);
    for (const [index, topic] of topics.entries()) {
      const selected = publicCandidateEvidence(selections[index]);
      expect(selected.filter((record) => record.topics.includes(topic)).length).toBeGreaterThanOrEqual(8);
    }
  });

  it("exposes only sanitized candidate facts to the browser boundary", () => {
    const narrative = assembleCandidateNarrative(["T-002", "T-004"]);
    const visible = publicCandidateEvidence(narrative.sections.flatMap((section) => section.evidenceRefs));
    expect(visible.length).toBeGreaterThan(10);
    for (const record of visible) {
      expect(Object.keys(record).sort()).toEqual(["attribution", "claim", "id", "topics"]);
    }
    const serialized = JSON.stringify(visible);
    expect(serialized).not.toContain("source_refs");
    expect(serialized).not.toContain("filename");
    expect(serialized).not.toContain("sha256");
    expect(serialized).not.toContain("knowledge_only");
    expect(serialized).not.toContain("evidence_strength");
  });

  it("sends only section-selected candidate facts to bounded AI framing", async () => {
    process.env.BENFACTS_VALIDATION_MODE = "candidates";
    process.env.OPENAI_API_KEY = "test-only";
    const fallback = assembleCandidateNarrative(["T-003"]);
    let requestBody: Record<string, unknown> | undefined;
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({ sections: fallback.sections.map((section) => ({
        id: section.id,
        headline: section.headline,
        summary: section.summary
      })) }) }), { status: 200 });
    };
    const result = await generateNarrative(["T-003"], fakeFetch as typeof fetch);
    expect(result.mode).toBe("ai");
    expect(result.grounding).toBe("candidate_validation");
    const input = JSON.parse(String(requestBody?.input));
    const visible = input.sections.flatMap((section: { evidence: unknown[] }) => section.evidence);
    expect(visible.every((record: { id: string }) => record.id.startsWith("BF-C-"))).toBe(true);
    expect(JSON.stringify(visible)).not.toContain("source_refs");
    expect(JSON.stringify(requestBody?.instructions)).toContain("unapproved candidate BenFacts");
  });
});

