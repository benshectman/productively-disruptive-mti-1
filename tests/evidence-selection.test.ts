import { describe, expect, it } from "vitest";

import { applyAiFraming } from "../netlify/functions/generate";
import {
  approvedBenFactIds,
  assembleApprovedBenFactsNarrativeWithFieldEvidence
} from "../src/shared/approved-benfacts";
import { NarrativeSchema, type GenerationDiagnostics, type GenerationRejection, type PublicEvidence, type TopicId } from "../src/shared/contracts";
import { buildEligibleSectionEvidencePools } from "../src/shared/eligible-evidence";

const experimentalIds = ["system-behind-design", "operating-model", "institutionalized-capability"];

function setup(topics: TopicId[] = ["T-003"]) {
  const { narrative: fallback, fieldEvidenceBySection } = assembleApprovedBenFactsNarrativeWithFieldEvidence(topics);
  const eligibleEvidenceBySection = new Map<string, PublicEvidence[]>(
    buildEligibleSectionEvidencePools(topics).map((pool) => [pool.sectionId, pool.facts])
  );
  const evidenceTextBySection = new Map(fallback.sections.map((section) => [
    section.id,
    (eligibleEvidenceBySection.get(section.id) || []).map((fact) => fact.claim).join(" ")
  ]));
  const framing = {
    sections: fallback.sections.map(({ id, headline, summary, detail }) => {
      const section = { id, headline, summary, detail } as Record<string, unknown>;
      if (experimentalIds.includes(id)) {
        const ids = eligibleEvidenceBySection.get(id)!.map((fact) => fact.id);
        section.summary_evidence_fact_ids = [ids.at(-1)!];
        section.detail_evidence_fact_ids = [ids.at(-2)!];
      }
      return section;
    })
  };
  return { fallback, fieldEvidenceBySection, eligibleEvidenceBySection, evidenceTextBySection, framing };
}

function apply(setupValue: ReturnType<typeof setup>) {
  const rejections: GenerationRejection[] = [];
  let diagnostics: GenerationDiagnostics | undefined;
  const narrative = applyAiFraming(
    setupValue.framing,
    setupValue.fallback,
    approvedBenFactIds,
    setupValue.evidenceTextBySection,
    undefined,
    (value) => { diagnostics = value; },
    (rejection) => { rejections.push(rejection); },
    {
      eligibleEvidenceBySection: setupValue.eligibleEvidenceBySection,
      fallbackFieldEvidenceBySection: setupValue.fieldEvidenceBySection,
      includeDiagnostics: true
    }
  );
  return { narrative, diagnostics, rejections };
}

describe("small-pool framing evidence selection", () => {
  it("makes all seven About Ben, all twenty Recent Leadership, and all five Career Throughline facts eligible", () => {
    const pools = buildEligibleSectionEvidencePools(["T-003"]);
    const about = pools.find((pool) => pool.sectionId === "system-behind-design")!;
    const recentLeadership = pools.find((pool) => pool.sectionId === "operating-model")!;
    const throughline = pools.find((pool) => pool.sectionId === "institutionalized-capability")!;

    expect(about.facts.map((fact) => fact.id).sort()).toEqual([
      "BF-C-033", "BF-C-043", "BF-C-045", "BF-C-049", "BF-C-073", "BF-C-074", "BF-C-076"
    ]);
    expect(throughline.facts.map((fact) => fact.id).sort()).toEqual([
      "BF-C-075", "BF-C-076", "BF-C-077", "BF-C-078", "BF-C-079"
    ]);
    expect(recentLeadership.facts).toHaveLength(20);
  });

  it("accepts any supplied fact and replaces deterministic rail refs with generated citations", () => {
    const value = setup();
    const aboutFallback = value.fallback.sections.find((section) => section.id === "system-behind-design")!;
    const citedIds = [
      value.framing.sections[0].summary_evidence_fact_ids as string[],
      value.framing.sections[0].detail_evidence_fact_ids as string[]
    ].flat();
    expect(citedIds.some((id) => !aboutFallback.evidenceRefs.includes(id))).toBe(true);

    const { narrative } = apply(value);
    expect(narrative?.sections.find((section) => section.id === "system-behind-design")?.evidenceRefs)
      .toEqual(citedIds);
  });

  it("preserves generated summary provenance with fallback detail provenance", () => {
    const value = setup();
    const about = value.framing.sections.find((section) => section.id === "system-behind-design")!;
    about.detail = "Too short";
    const citedSummary = about.summary_evidence_fact_ids as string[];
    const fallbackDetail = value.fieldEvidenceBySection.get("system-behind-design")!.detail;

    const { narrative } = apply(value);
    const result = narrative!.sections.find((section) => section.id === "system-behind-design")!;
    expect(result.summary).toBe(about.summary);
    expect(result.detail).toBe(value.fallback.sections.find((section) => section.id === result.id)!.detail);
    expect(result.evidenceRefs).toEqual([...new Set([...citedSummary, ...fallbackDetail])]);
  });

  it("preserves fallback summary provenance with generated detail provenance", () => {
    const value = setup();
    const throughline = value.framing.sections.find((section) => section.id === "institutionalized-capability")!;
    throughline.summary = "Too short";
    const fallbackSummary = value.fieldEvidenceBySection.get("institutionalized-capability")!.summary;
    const citedDetail = throughline.detail_evidence_fact_ids as string[];

    const { narrative } = apply(value);
    const result = narrative!.sections.find((section) => section.id === "institutionalized-capability")!;
    expect(result.summary).toBe(value.fallback.sections.find((section) => section.id === result.id)!.summary);
    expect(result.detail).toBe(throughline.detail);
    expect(result.evidenceRefs).toEqual([...new Set([...fallbackSummary, ...citedDetail])]);
  });

  it.each(["BF-C-999", "BF-C-075"])("rejects invented or out-of-section ID %s locally", (invalidId) => {
    const value = setup();
    const about = value.framing.sections.find((section) => section.id === "system-behind-design")!;
    about.summary_evidence_fact_ids = [invalidId];

    const { narrative, diagnostics, rejections } = apply(value);
    const result = narrative!.sections.find((section) => section.id === "system-behind-design")!;
    expect(result.summary).toBe(value.fallback.sections.find((section) => section.id === result.id)!.summary);
    expect(result.detail).toBe(about.detail);
    expect(diagnostics?.sections.find((section) => section.id === result.id)).toMatchObject({
      fields: { summary: "fallback", detail: "ai" },
      evidence: { invalidSummaryCitedIds: [invalidId] }
    });
    expect(rejections).toContainEqual(expect.objectContaining({
      sectionId: "system-behind-design",
      field: "summary",
      category: "evidence-provenance",
      context: expect.objectContaining({ invalidEvidenceIds: [invalidId], fallbackApplied: true })
    }));
  });

  it("updates Recent Leadership evidence from generated citations while leaving Proof in Practice unchanged", () => {
    const value = setup();
    const operatingFallback = value.fallback.sections.find((section) => section.id === "operating-model")!;
    const proofFallback = value.fallback.sections.find((section) => section.id === "proof-to-scale")!;
    const operatingFraming = value.framing.sections.find((section) => section.id === "operating-model")!;
    const operatingCitations = [
      ...(operatingFraming.summary_evidence_fact_ids as string[]),
      ...(operatingFraming.detail_evidence_fact_ids as string[])
    ];

    const { narrative, diagnostics } = apply(value);
    expect(narrative?.sections.find((section) => section.id === "operating-model")?.evidenceRefs)
      .toEqual(operatingCitations);
    expect(operatingCitations.some((id) => !operatingFallback.evidenceRefs.includes(id))).toBe(true);
    expect(narrative?.sections.find((section) => section.id === "proof-to-scale")?.evidenceRefs)
      .toEqual(proofFallback.evidenceRefs);
    expect(narrative?.sections.find((section) => section.id === "proof-to-scale")?.proof_items)
      .toEqual(proofFallback.proof_items);
    expect(diagnostics?.sections.find((section) => section.id === "operating-model")?.evidence).toMatchObject({
      eligibleFactCount: 20,
      generatedSummaryCitedIds: operatingFraming.summary_evidence_fact_ids,
      generatedDetailCitedIds: operatingFraming.detail_evidence_fact_ids,
      finalDisplayedEvidenceIds: operatingCitations
    });
    expect(diagnostics?.sections.find((section) => section.id === "proof-to-scale")).not.toHaveProperty("evidence");
  });

  it("preserves generated Recent Leadership summary provenance with fallback detail provenance", () => {
    const value = setup();
    const recent = value.framing.sections.find((section) => section.id === "operating-model")!;
    recent.detail = "Too short";
    const citedSummary = recent.summary_evidence_fact_ids as string[];
    const fallbackDetail = value.fieldEvidenceBySection.get("operating-model")!.detail;

    const { narrative } = apply(value);
    const result = narrative!.sections.find((section) => section.id === "operating-model")!;
    expect(result.summary).toBe(recent.summary);
    expect(result.detail).toBe(value.fallback.sections.find((section) => section.id === result.id)!.detail);
    expect(result.evidenceRefs).toEqual([...new Set([...citedSummary, ...fallbackDetail])]);
  });

  it("supports a Recent Leadership rail containing all twenty eligible facts", () => {
    const value = setup();
    const recent = value.framing.sections.find((section) => section.id === "operating-model")!;
    const allEligibleIds = value.eligibleEvidenceBySection.get("operating-model")!.map((fact) => fact.id);
    recent.summary_evidence_fact_ids = allEligibleIds;
    recent.detail_evidence_fact_ids = allEligibleIds;

    const { narrative } = apply(value);
    const result = narrative!.sections.find((section) => section.id === "operating-model")!;
    expect(result.evidenceRefs).toEqual(allEligibleIds);
    expect(() => NarrativeSchema.parse(narrative)).not.toThrow();
  });

  it("reports eligible, cited, rejected, and final displayed evidence IDs", () => {
    const value = setup();
    const throughline = value.framing.sections.find((section) => section.id === "institutionalized-capability")!;
    throughline.detail_evidence_fact_ids = ["BF-C-999"];

    const { diagnostics } = apply(value);
    const evidence = diagnostics?.sections.find((section) => section.id === "institutionalized-capability")?.evidence;
    expect(evidence).toMatchObject({
      eligibleFactCount: 5,
      eligibleFactIds: expect.arrayContaining(["BF-C-075", "BF-C-076", "BF-C-077", "BF-C-078", "BF-C-079"]),
      generatedSummaryCitedIds: throughline.summary_evidence_fact_ids,
      generatedDetailCitedIds: ["BF-C-999"],
      invalidDetailCitedIds: ["BF-C-999"]
    });
    expect(evidence?.finalDisplayedEvidenceIds).toEqual([...new Set([
      ...(throughline.summary_evidence_fact_ids as string[]),
      ...value.fieldEvidenceBySection.get("institutionalized-capability")!.detail
    ])]);
  });
});
