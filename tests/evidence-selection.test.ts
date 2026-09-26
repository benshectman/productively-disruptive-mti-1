import { describe, expect, it } from "vitest";

import { applyAiFraming } from "../netlify/functions/generate";
import approvedCorpusJson from "../src/content/approved/ben-facts.v1.json";
import {
  approvedBenFactIds,
  assembleApprovedBenFactsNarrativeWithFieldEvidence
} from "../src/shared/approved-benfacts";
import { approvedEditorialMetadata } from "../src/shared/approved-editorial-metadata";
import { NarrativeSchema, type GenerationDiagnostics, type GenerationRejection, type TopicId } from "../src/shared/contracts";
import { buildEligibleSharedFramingEvidence, sharedFramingSectionIds } from "../src/shared/eligible-evidence";

const experimentalIds = ["system-behind-design", "operating-model", "institutionalized-capability"];
const allowedAttributions = new Set(["personal", "leadership", "team", "organization", "shared_leadership"]);
const approvedCorpus = approvedCorpusJson as unknown as {
  facts: Array<{ id: string; visibility: string; attribution: string; project_id?: string }>;
};

function expectedSharedNonProjectIds() {
  return approvedCorpus.facts
    .filter((fact) => fact.visibility === "shareable" && allowedAttributions.has(fact.attribution) && !fact.project_id)
    .map((fact) => fact.id);
}

function setup(topics: TopicId[] = ["T-003"]) {
  const { narrative: fallback, fieldEvidenceBySection } = assembleApprovedBenFactsNarrativeWithFieldEvidence(topics);
  const eligibleSharedFramingEvidence = buildEligibleSharedFramingEvidence(topics);
  const sharedEvidenceText = eligibleSharedFramingEvidence.map((fact) => fact.claim).join(" ");
  const evidenceTextBySection = new Map(fallback.sections.map((section) => [
    section.id,
    experimentalIds.includes(section.id) ? sharedEvidenceText : ""
  ]));
  const framing = {
    sections: fallback.sections.map(({ id, headline, summary, detail }) => {
      const section = { id, headline, summary, detail } as Record<string, unknown>;
      if (experimentalIds.includes(id)) {
        const ids = eligibleSharedFramingEvidence.map((fact) => fact.id);
        section.summary_evidence_fact_ids = [ids.at(-1)!];
        section.detail_evidence_fact_ids = [ids.at(-2)!];
      }
      return section;
    })
  };
  return { fallback, fieldEvidenceBySection, eligibleSharedFramingEvidence, evidenceTextBySection, framing };
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
      eligibleSharedFramingEvidence: setupValue.eligibleSharedFramingEvidence,
      fallbackFieldEvidenceBySection: setupValue.fieldEvidenceBySection,
      includeDiagnostics: true
    }
  );
  return { narrative, diagnostics, rejections };
}

describe("shared non-project framing evidence selection", () => {
  it("gives all three framing sections the same complete eligible non-project pool", () => {
    const sharedPool = buildEligibleSharedFramingEvidence(["T-003"]);
    const expectedIds = expectedSharedNonProjectIds().sort();

    expect(sharedPool.map((fact) => fact.id).sort()).toEqual(expectedIds);
    expect(sharedPool.every((fact) => !fact.project_id)).toBe(true);
    expect(sharedFramingSectionIds).toHaveLength(3);
  });

  it("keeps legacy narrative roles as hints without changing eligibility", () => {
    const sharedPool = buildEligibleSharedFramingEvidence(["T-003"]);
    const roleMismatch = sharedPool.find((fact) => {
      const roles = approvedEditorialMetadata[fact.id]?.narrativeRoles || [];
      return roles.length > 0 && !roles.includes("about");
    })!;

    expect(roleMismatch).toBeTruthy();
    expect(roleMismatch.legacy_narrative_roles).toEqual(approvedEditorialMetadata[roleMismatch.id].narrativeRoles);
    expect(sharedFramingSectionIds).toEqual(expect.arrayContaining(experimentalIds));

    const value = setup();
    const aboutFraming = value.framing.sections.find((section) => section.id === "system-behind-design")!;
    aboutFraming.summary_evidence_fact_ids = [roleMismatch.id];
    const { narrative, rejections } = apply(value);
    expect(narrative?.sections.find((section) => section.id === "system-behind-design")?.summary).toBe(aboutFraming.summary);
    expect(rejections.filter((rejection) => rejection.field === "summary")).toEqual([]);
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

  it.each(experimentalIds)("lets %s cite any valid fact from the shared pool", (sectionId) => {
    const value = setup();
    const sharedFactId = value.eligibleSharedFramingEvidence[0].id;
    const framingSection = value.framing.sections.find((section) => section.id === sectionId)!;
    framingSection.summary_evidence_fact_ids = [sharedFactId];
    framingSection.detail_evidence_fact_ids = [sharedFactId];

    const { narrative, rejections } = apply(value);
    expect(narrative?.sections.find((section) => section.id === sectionId)?.evidenceRefs).toEqual([sharedFactId]);
    expect(rejections.filter((rejection) => rejection.sectionId === sectionId && rejection.category === "evidence-provenance")).toEqual([]);
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

  it.each(["BF-C-999", "BF-C-051"])("rejects invented or project-specific ID %s locally", (invalidId) => {
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
      eligibleFactCount: expectedSharedNonProjectIds().length,
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

  it("supports a Recent Leadership rail containing the complete shared pool", () => {
    const value = setup();
    const recent = value.framing.sections.find((section) => section.id === "operating-model")!;
    const allEligibleIds = value.eligibleSharedFramingEvidence.map((fact) => fact.id);
    recent.summary_evidence_fact_ids = allEligibleIds;
    recent.detail_evidence_fact_ids = allEligibleIds;

    const { narrative } = apply(value);
    const result = narrative!.sections.find((section) => section.id === "operating-model")!;
    expect(result.evidenceRefs).toEqual(allEligibleIds);
    expect(() => NarrativeSchema.parse(narrative)).not.toThrow();
  });

  it("reports identical shared eligible pools and bounded citations for all three sections", () => {
    const value = setup();
    const { diagnostics } = apply(value);
    const evidenceDiagnostics = experimentalIds.map((id) => diagnostics!.sections.find((section) => section.id === id)!.evidence!);
    const expectedIds = value.eligibleSharedFramingEvidence.map((fact) => fact.id);

    expect(diagnostics?.sharedFramingEvidence).toEqual({
      eligibleFactCount: expectedIds.length,
      eligibleFactIds: expectedIds,
      availableToSectionIds: sharedFramingSectionIds
    });

    for (const evidence of evidenceDiagnostics) {
      expect(evidence.eligibleFactCount).toBe(expectedIds.length);
      expect(evidence.eligibleFactIds).toEqual(expectedIds);
      expect([...evidence.generatedSummaryCitedIds, ...evidence.generatedDetailCitedIds]
        .every((id) => expectedIds.includes(id))).toBe(true);
      expect(evidence.finalDisplayedEvidenceIds.every((id) => expectedIds.includes(id))).toBe(true);
    }
  });

  it("reports eligible, cited, rejected, and final displayed evidence IDs", () => {
    const value = setup();
    const throughline = value.framing.sections.find((section) => section.id === "institutionalized-capability")!;
    throughline.detail_evidence_fact_ids = ["BF-C-999"];

    const { diagnostics } = apply(value);
    const evidence = diagnostics?.sections.find((section) => section.id === "institutionalized-capability")?.evidence;
    expect(evidence).toMatchObject({
      eligibleFactCount: expectedSharedNonProjectIds().length,
      eligibleFactIds: expect.arrayContaining(expectedSharedNonProjectIds()),
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
