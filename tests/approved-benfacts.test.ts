import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import approvedCorpus from "../src/content/approved/ben-facts.v1.json";
import candidateCorpus from "../src/content/candidates/ben-facts-migration.v0.4.json";
import reviewCorpus from "../src/content/review/ben-facts-review.v1.json";
import { applyAiProofItem, generateNarrative } from "../netlify/functions/generate";
import {
  approvedBenFactIds,
  assembleApprovedBenFactsNarrative,
  buildApprovedProofItem,
  proofItemEvidenceIds,
  publicApprovedBenFacts,
  selectApprovedProofProjects,
  validateNarrativeProofProjects,
  validateProofItemProjectEvidence
} from "../src/shared/approved-benfacts";
import type { TopicId } from "../src/shared/contracts";

afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe("approved BenFacts runtime corpus", () => {
  const allTopicConfigurations: TopicId[][] = Array.from({ length: 16 }, (_, mask) =>
    (["T-001", "T-002", "T-003", "T-004"] as TopicId[]).filter((_, index) => mask & (1 << index))
  );

  it("builds the deterministic fallback only from promoted approved facts", async () => {
    const narrative = await generateNarrative([]);
    const refs = narrative.sections.flatMap((section) => section.evidenceRefs);
    expect(narrative.mode).toBe("deterministic");
    expect(narrative.grounding).toBe("approved");
    expect(refs.every((id) => approvedBenFactIds.has(id))).toBe(true);
    expect(refs.every((id) => approvedCorpus.facts.some((fact) => fact.id === id))).toBe(true);
  });

  it("does not expose candidate or review wording through the runtime adapter", () => {
    const visible = publicApprovedBenFacts();
    const approvedById = new Map(approvedCorpus.facts.map((fact) => [fact.id, fact.claim]));
    const candidateOnly = candidateCorpus.candidates.filter((candidate) => !approvedById.has(candidate.candidate_id));
    const reviewOnlyText = reviewCorpus.candidates
      .filter((candidate) => !approvedById.has(candidate.candidate_id))
      .map((candidate) => candidate.reviewed_text);
    expect(visible).toHaveLength(approvedCorpus.meta.approved_count);
    expect(visible.every((fact) => fact.claim === approvedById.get(fact.id))).toBe(true);
    expect(visible.some((fact) => candidateOnly.some((candidate) => candidate.original_text === fact.claim))).toBe(false);
    expect(visible.some((fact) => reviewOnlyText.includes(fact.claim))).toBe(false);
    expect(JSON.stringify(visible)).not.toContain("review_status");
    expect(JSON.stringify(visible)).not.toContain("source_refs");
  });

  it("keeps candidate and review files out of runtime imports", () => {
    const runtimeSources = [
      readFileSync(new URL("../src/shared/approved-benfacts.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../netlify/functions/generate.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../src/shared/narrative.ts", import.meta.url), "utf8")
    ].join("\n");
    expect(runtimeSources).not.toContain("content/candidates");
    expect(runtimeSources).not.toContain("content/review");
  });

  it("changes approved selection by visitor topic", () => {
    const selections = (["T-001", "T-002", "T-003", "T-004"] as TopicId[])
      .map((topic) => assembleApprovedBenFactsNarrative([topic]).sections.flatMap((section) => section.evidenceRefs));
    expect(new Set(selections.map((selection) => selection.join("|"))).size).toBe(4);
  });

  it.each(allTopicConfigurations.map((topics) => [topics]))(
    "keeps every Proof in Practice item within one approved project for %j",
    (topics) => {
      const projects = selectApprovedProofProjects(topics);
      expect(projects).toHaveLength(3);
      for (const project of projects) {
        const item = buildApprovedProofItem(project);
        expect(validateProofItemProjectEvidence(item)).toBe(true);
        expect(proofItemEvidenceIds(item).every((id) => approvedBenFactIds.has(id))).toBe(true);
      }
      expect(validateNarrativeProofProjects(assembleApprovedBenFactsNarrative(topics))).toBe(true);
    }
  );

  it("rejects cross-project evidence contamination", () => {
    const project = selectApprovedProofProjects(["T-004"]).find((item) => item.project_id === "spr")!;
    const fallback = buildApprovedProofItem(project);
    const contaminated = structuredClone(fallback);
    contaminated.actions[0].evidence_fact_ids = ["BF-C-053"];
    expect(validateProofItemProjectEvidence(contaminated)).toBe(false);
    const evidenceText = publicApprovedBenFacts(proofItemEvidenceIds(fallback)).map((record) => record.claim).join(" ");
    expect(applyAiProofItem(contaminated, fallback, evidenceText)).toBeNull();
  });

  it("sends only selected approved facts to bounded AI framing", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    const fallback = assembleApprovedBenFactsNarrative(["T-003"]);
    const requestBodies: Record<string, any>[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requestBodies.push(body);
      if (body.text.format.name === "portfolio_narrative") {
        return new Response(JSON.stringify({ output_text: JSON.stringify({ sections: fallback.sections.map(({ id, headline, summary, detail }) => ({ id, headline, summary, detail })) }) }), { status: 200 });
      }
      const input = JSON.parse(body.input);
      const item = fallback.sections[3].proof_items!.find((proof) => proof.project_id === input.project_id)!;
      return new Response(JSON.stringify({ output_text: JSON.stringify(item) }), { status: 200 });
    };
    const result = await generateNarrative(["T-003"], fakeFetch as typeof fetch);
    expect(result.grounding).toBe("approved");
    const serialized = JSON.stringify(requestBodies);
    expect(serialized).toContain("Use only the approved BenFacts");
    expect(serialized).not.toContain("unapproved candidate");
    expect(serialized).not.toContain("review_status");
    expect(serialized).not.toContain("source_refs");
    const framing = requestBodies.find((body) => body.text.format.name === "portfolio_narrative")!;
    const evidence = JSON.parse(framing.input).sections.flatMap((section: { evidence: Array<{ id: string }> }) => section.evidence);
    expect(evidence.every((fact: { id: string }) => approvedBenFactIds.has(fact.id))).toBe(true);
  });
});
