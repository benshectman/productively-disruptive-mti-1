import approvedCorpusJson from "../content/approved/ben-facts.v1.json";
import { approvedEditorialMetadata, type NarrativeRole } from "./approved-editorial-metadata";
import type { Attribution, PublicEvidence, TopicId } from "./contracts";

export type EligibleEvidenceRecord = PublicEvidence & {
  project_id?: string;
  career_context_id?: string;
  period?: { start_year: number; end_year?: number };
};

export type NarrativeSectionId =
  | "system-behind-design"
  | "operating-model"
  | "institutionalized-capability"
  | "proof-to-scale";

export type SectionEvidencePool = {
  sectionId: NarrativeSectionId;
  facts: EligibleEvidenceRecord[];
};

type ApprovedCorpusFact = {
  id: string;
  claim: string;
  attribution: Attribution;
  topics: TopicId[];
  visibility: string;
  project_id?: string;
  career_context_id?: string;
  period?: { start_year: number; end_year?: number };
};

const approvedCorpus = approvedCorpusJson as unknown as { facts: ApprovedCorpusFact[] };
const allowedAttributions = new Set<Attribution>(["personal", "leadership", "team", "organization", "shared_leadership"]);

const eligibleFacts: EligibleEvidenceRecord[] = approvedCorpus.facts
  .filter((fact) => fact.visibility === "shareable" && allowedAttributions.has(fact.attribution))
  .map((fact) => ({
    id: fact.id,
    claim: fact.claim,
    attribution: fact.attribution,
    topics: fact.topics,
    ...(fact.project_id ? { project_id: fact.project_id } : {}),
    ...(fact.career_context_id ? { career_context_id: fact.career_context_id } : {}),
    ...(fact.period ? { period: fact.period } : {})
  }));

const sectionRoles: Record<Exclude<NarrativeSectionId, "proof-to-scale">, NarrativeRole> = {
  "system-behind-design": "about",
  "operating-model": "recent_leadership",
  "institutionalized-capability": "throughline"
};

function topicOverlap(fact: EligibleEvidenceRecord, topics: TopicId[]) {
  return fact.topics.filter((topic) => topics.includes(topic)).length;
}

function orderedForTopics(facts: EligibleEvidenceRecord[], topics: TopicId[]) {
  return [...facts].sort((a, b) => topicOverlap(b, topics) - topicOverlap(a, topics) || a.id.localeCompare(b.id));
}

export function buildEligibleSectionEvidencePools(topics: TopicId[]): SectionEvidencePool[] {
  return (Object.entries(sectionRoles) as Array<[Exclude<NarrativeSectionId, "proof-to-scale">, NarrativeRole]>).map(([sectionId, role]) => ({
    sectionId,
    facts: orderedForTopics(
      eligibleFacts.filter((fact) => approvedEditorialMetadata[fact.id]?.narrativeRoles.includes(role)),
      topics
    )
  }));
}

export function buildEligibleProjectEvidence(projectId: string, topics: TopicId[] = []): EligibleEvidenceRecord[] {
  return orderedForTopics(eligibleFacts.filter((fact) => fact.project_id === projectId), topics);
}

export function eligibleEvidencePoolDiagnostics(topics: TopicId[]) {
  return {
    sections: buildEligibleSectionEvidencePools(topics).map((pool) => ({
      section_id: pool.sectionId,
      eligible_fact_count: pool.facts.length,
      eligible_fact_ids: pool.facts.map((fact) => fact.id)
    }))
  };
}
