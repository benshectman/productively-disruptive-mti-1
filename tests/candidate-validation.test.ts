import { afterEach, describe, expect, it } from "vitest";
import { applyAiProofItem, generateNarrative } from "../netlify/functions/generate";
import {
  assembleCandidateNarrative,
  assembleEditorialCandidateNarrative,
  assembleLegacyCandidateNarrative,
  buildCandidateProofItem,
  candidateValidationIds,
  proofItemEvidenceIds,
  publicCandidateEvidence,
  selectCandidateProofProjects,
  validateNarrativeProofProjects,
  validateProofItemProjectEvidence
} from "../netlify/functions/candidate-validation";
import { assembleNarrative } from "../src/shared/narrative";
import type { TopicId } from "../src/shared/contracts";

afterEach(() => {
  delete process.env.BENFACTS_VALIDATION_MODE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.NARRATIVE_PLANNER_MODE;
});

describe("temporary candidate BenFacts validation mode", () => {
  const allTopicConfigurations: TopicId[][] = Array.from({ length: 16 }, (_, mask) =>
    (["T-001", "T-002", "T-003", "T-004"] as TopicId[]).filter((_, index) => mask & (1 << index))
  );
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

  it("preserves the previous planner as a stable legacy rollback path", () => {
    const refs = assembleLegacyCandidateNarrative([]).sections.map((section) => section.evidenceRefs);
    expect(refs.slice(0, 3)).toEqual([
      ["BF-C-073", "BF-C-076", "BF-C-033"],
      ["BF-C-036", "BF-C-037", "BF-C-038", "BF-C-039"],
      ["BF-C-077", "BF-C-078", "BF-C-079"]
    ]);
    expect(refs[3]).not.toContain("BF-C-062");
    expect(validateNarrativeProofProjects(assembleLegacyCandidateNarrative([]))).toBe(true);
    process.env.NARRATIVE_PLANNER_MODE = "legacy";
    expect(assembleCandidateNarrative([])).toEqual(assembleLegacyCandidateNarrative([]));
  });

  it("plans a broad-to-specific editorial arc with recent experience as its center of gravity", () => {
    const narrative = assembleEditorialCandidateNarrative(["T-001", "T-002"]);
    expect(narrative.sections.map((section) => section.eyebrow)).toEqual([
      "About Ben", "Recent leadership", "Career throughline", "Proof in practice"
    ]);
    expect(narrative.sections[0].evidenceRefs).toEqual(expect.arrayContaining(["BF-C-073", "BF-C-076"]));
    expect(narrative.sections[2].evidenceRefs[0]).toBe("BF-C-075");
    expect(narrative.sections[2].evidenceRefs.slice(1).every((id) => Number(id.slice(-3)) >= 77)).toBe(true);
    const refs = narrative.sections.flatMap((section) => section.evidenceRefs);
    expect(new Set(refs).size).toBe(refs.length);
    const recentCount = refs.filter((id) => {
      const number = Number(id.slice(-3));
      return number >= 33 && number <= 75 && number !== 73;
    }).length;
    expect(recentCount / refs.length).toBeGreaterThanOrEqual(0.6);
  });

  it.each(allTopicConfigurations.map((topics) => [topics]))(
    "selects projects before facts and keeps every proof item within one project for %j",
    (topics) => {
      const projects = selectCandidateProofProjects(topics);
      expect(projects).toHaveLength(3);
      expect(new Set(projects.map((project) => project.project_id)).size).toBe(3);
      for (const project of projects) {
        const item = buildCandidateProofItem(project);
        expect(validateProofItemProjectEvidence(item)).toBe(true);
        expect(proofItemEvidenceIds(item).length).toBeGreaterThan(0);
        const words = item.summary.narrative.trim().split(/\s+/).length;
        expect(words).toBeGreaterThanOrEqual(25);
        expect(words).toBeLessThanOrEqual(45);
        expect(item.summary.narrative).not.toMatch(/[.!?]\s+\S/);
      }
    }
  );

  it("recognizes every attribution-safe project_id in the v0.3 runtime corpus", () => {
    const selected = selectCandidateProofProjects([], Number.POSITIVE_INFINITY);
    expect(selected.map((project) => project.project_id).sort()).toEqual([
      "askgs",
      "comet-change-control",
      "emarketplace-purchasing",
      "first-tpi-due-diligence",
      "pqm360",
      "spr",
      "supplier-risk-sensing",
      "vital",
      "xiam"
    ]);
    expect(candidateValidationIds.has("BF-C-009")).toBe(false);
    expect(candidateValidationIds.has("BF-C-010")).toBe(false);
  });

  it("rejects cross-project evidence contamination even when the fact id is otherwise allowed", () => {
    const [askgs] = selectCandidateProofProjects(["T-001"]).filter((project) => project.project_id === "askgs");
    expect(askgs).toBeDefined();
    if (!askgs) throw new Error("Expected AskGS project");
    const contaminated = structuredClone(buildCandidateProofItem(askgs));
    contaminated.summary.evidence_fact_ids = ["BF-C-056"];
    expect(candidateValidationIds.has("BF-C-056")).toBe(true);
    expect(validateProofItemProjectEvidence(contaminated)).toBe(false);
  });

  it("rejects a model-generated proof item that cites evidence from another project", () => {
    const project = selectCandidateProofProjects(["T-004"]).find((candidate) => candidate.project_id === "spr");
    expect(project).toBeDefined();
    if (!project) throw new Error("Expected Service Performance Reporting project");
    const fallback = buildCandidateProofItem(project);
    const evidenceText = publicCandidateEvidence(proofItemEvidenceIds(fallback)).map((record) => record.claim).join(" ");
    expect(applyAiProofItem(fallback, fallback, evidenceText)).toEqual(fallback);

    const contaminated = structuredClone(fallback);
    contaminated.actions[0].evidence_fact_ids = ["BF-C-053"];
    expect(applyAiProofItem(contaminated, fallback, `${evidenceText} ${publicCandidateEvidence(["BF-C-053"])[0].claim}`)).toBeNull();
  });

  it("keeps internal semantic purposes out of visitor-facing labels", () => {
    const internalLabels = new Set(["proposition", "evidence", "transition", "story"]);
    for (const mode of ["legacy", "editorial"] as const) {
      expect(assembleCandidateNarrative([], mode).sections.every((section) => !internalLabels.has(section.eyebrow.toLowerCase()))).toBe(true);
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
    const requestBodies: Record<string, any>[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body));
      requestBodies.push(requestBody);
      const formatName = requestBody.text.format.name as string;
      if (formatName === "portfolio_narrative") {
        return new Response(JSON.stringify({ output_text: JSON.stringify({ sections: fallback.sections.map((section) => ({
          id: section.id,
          headline: section.headline,
          summary: section.summary,
          detail: section.detail
        })) }) }), { status: 200 });
      }
      const input = JSON.parse(requestBody.input);
      const item = fallback.sections.find((section) => section.id === "proof-to-scale")!.proof_items!
        .find((proof) => proof.project_id === input.project_id)!;
      return new Response(JSON.stringify({ output_text: JSON.stringify(item) }), { status: 200 });
    };
    const result = await generateNarrative(["T-003"], fakeFetch as typeof fetch);
    expect(result.mode).toBe("ai");
    expect(result.grounding).toBe("candidate_validation");
    const framingRequest = requestBodies.find((body) => body.text.format.name === "portfolio_narrative")!;
    const input = JSON.parse(String(framingRequest.input));
    const visible = input.sections.flatMap((section: { evidence: unknown[] }) => section.evidence);
    expect(visible.every((record: { id: string }) => record.id.startsWith("BF-C-"))).toBe(true);
    expect(JSON.stringify(visible)).not.toContain("source_refs");
    expect(JSON.stringify(framingRequest.instructions)).toContain("unapproved candidate BenFacts");
    expect(JSON.stringify(framingRequest.instructions)).toContain("continuous professional portfolio narrative");
    expect(input.sections.map((section: { audienceLabel: string }) => section.audienceLabel)).toEqual([
      "About Ben", "Recent leadership", "Career throughline", "Proof in practice"
    ]);
    const proofRequests = requestBodies.filter((body) => body.text.format.name.startsWith("proof_item_"));
    expect(proofRequests).toHaveLength(3);
    for (const body of proofRequests) {
      const proofInput = JSON.parse(body.input);
      expect(new Set(proofInput.evidence.map((record: { id: string }) => record.id)).size).toBe(proofInput.evidence.length);
      expect(proofInput.evidence.every((record: { id: string }) => proofItemEvidenceIds(
        fallback.sections[3].proof_items!.find((item) => item.project_id === proofInput.project_id)!
      ).includes(record.id))).toBe(true);
    }
    expect(result.sections.map((section) => section.summary)).toEqual(fallback.sections.map((section) => section.summary));
  });
});

