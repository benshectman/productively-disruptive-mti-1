import { afterEach, describe, expect, it } from "vitest";
import { generateNarrative } from "../netlify/functions/generate";
import {
  assembleApprovedBenFactsNarrative,
  proofItemEvidenceIds
} from "../src/shared/approved-benfacts";
import {
  buildEligibleProjectEvidence,
  buildEligibleSectionEvidencePools
} from "../src/shared/eligible-evidence";
import type { TopicId } from "../src/shared/contracts";

afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe("uncapped approved evidence eligibility", () => {
  it("keeps more than four eligible facts available for recent leadership", () => {
    const pool = buildEligibleSectionEvidencePools(["T-001"]).find((item) => item.sectionId === "operating-model")!;
    expect(pool.facts.length).toBeGreaterThan(4);
  });

  it("does not truncate a selected proof project's eligible facts to four", () => {
    const fallback = assembleApprovedBenFactsNarrative(["T-003"]);
    const project = fallback.sections.find((section) => section.id === "proof-to-scale")!.proof_items!
      .map((item) => ({ item, eligible: buildEligibleProjectEvidence(item.project_id, ["T-003"]) }))
      .find(({ item, eligible }) => eligible.length > proofItemEvidenceIds(item).length)!;
    expect(project.eligible.length).toBeGreaterThan(4);
    expect(project.eligible.length).toBeGreaterThan(proofItemEvidenceIds(project.item).length);
    expect(project.eligible.every((fact) => fact.project_id === project.item.project_id)).toBe(true);
  });

  it("sends eligible section and project pools to AI independently of fallback evidenceRefs", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    const topics: TopicId[] = ["T-003"];
    const fallback = assembleApprovedBenFactsNarrative(topics);
    const requestBodies: Record<string, any>[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requestBodies.push(body);
      if (body.text.format.name === "portfolio_narrative") {
        const input = JSON.parse(body.input);
        return new Response(JSON.stringify({ output_text: JSON.stringify({ sections: fallback.sections.map(({ id, headline, summary, detail }) => {
          const evidenceIds = input.sections.find((section: { id: string }) => section.id === id).evidence.map((fact: { id: string }) => fact.id);
          return {
            id, headline, summary, detail,
            ...(["system-behind-design", "institutionalized-capability"].includes(id) ? {
              summary_evidence_fact_ids: [evidenceIds[0]],
              detail_evidence_fact_ids: [evidenceIds.at(-1)]
            } : {})
          };
        }) }) }), { status: 200 });
      }
      const input = JSON.parse(body.input);
      const item = fallback.sections.find((section) => section.id === "proof-to-scale")!.proof_items!
        .find((proof) => proof.project_id === input.project_id)!;
      return new Response(JSON.stringify({ output_text: JSON.stringify(item) }), { status: 200 });
    };

    await generateNarrative(topics, fakeFetch as typeof fetch);

    const framing = requestBodies.find((body) => body.text.format.name === "portfolio_narrative")!;
    const framingInput = JSON.parse(framing.input);
    const recentInput = framingInput.sections.find((section: { id: string }) => section.id === "operating-model");
    const recentFallback = fallback.sections.find((section) => section.id === "operating-model")!;
    expect(recentInput.evidence.length).toBeGreaterThan(recentFallback.evidenceRefs.length);
    expect(recentInput.evidence.some((fact: { id: string }) => !recentFallback.evidenceRefs.includes(fact.id))).toBe(true);

    const aboutInput = framingInput.sections.find((section: { id: string }) => section.id === "system-behind-design");
    const throughlineInput = framingInput.sections.find((section: { id: string }) => section.id === "institutionalized-capability");
    expect(aboutInput.evidence).toHaveLength(7);
    expect(throughlineInput.evidence).toHaveLength(5);
    expect(aboutInput.requiresFieldEvidenceProvenance).toBe(true);
    expect(throughlineInput.requiresFieldEvidenceProvenance).toBe(true);
    expect(framing.instructions).toContain("You may use some or all of the supplied facts");

    const sectionSchemas = framing.text.format.schema.properties.sections.items.anyOf;
    for (const inputSection of [aboutInput, throughlineInput]) {
      const sectionSchema = sectionSchemas.find((schema: any) => schema.properties.id.enum[0] === inputSection.id);
      const eligibleIds = inputSection.evidence.map((fact: { id: string }) => fact.id);
      expect(sectionSchema.properties.summary_evidence_fact_ids.items.enum).toEqual(eligibleIds);
      expect(sectionSchema.properties.detail_evidence_fact_ids.items.enum).toEqual(eligibleIds);
    }

    const proofFallbacks = fallback.sections.find((section) => section.id === "proof-to-scale")!.proof_items!;
    const expandedProofRequest = requestBodies
      .filter((body) => body.text.format.name.startsWith("proof_item_"))
      .map((body) => ({ body, input: JSON.parse(body.input) }))
      .find(({ input }) => {
        const item = proofFallbacks.find((proof) => proof.project_id === input.project_id)!;
        return input.evidence.length > proofItemEvidenceIds(item).length;
      });
    expect(expandedProofRequest).toBeTruthy();
    const item = proofFallbacks.find((proof) => proof.project_id === expandedProofRequest!.input.project_id)!;
    expect(expandedProofRequest!.input.evidence).toHaveLength(buildEligibleProjectEvidence(item.project_id, topics).length);
    expect(expandedProofRequest!.input.evidence.every((fact: { project_id?: string }) => fact.project_id === item.project_id)).toBe(true);
  });
});
