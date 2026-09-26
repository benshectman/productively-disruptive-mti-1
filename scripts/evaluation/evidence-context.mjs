import approvedCorpusJson from "../../src/content/approved/ben-facts.v1.json" with { type: "json" };

const ALLOWED_ATTRIBUTIONS = new Set(["personal", "leadership", "team", "organization", "shared_leadership"]);

const SECTION_IDS = ["system-behind-design", "operating-model", "institutionalized-capability"];

const FACT_IDS_BY_ROLE = {
  about: ["BF-C-033", "BF-C-043", "BF-C-045", "BF-C-049", "BF-C-073", "BF-C-074", "BF-C-076"],
  recent_leadership: ["BF-C-033", "BF-C-034", "BF-C-035", "BF-C-036", "BF-C-037", "BF-C-038", "BF-C-039", "BF-C-040", "BF-C-041", "BF-C-042", "BF-C-043", "BF-C-044", "BF-C-045", "BF-C-046", "BF-C-047", "BF-C-048", "BF-C-049", "BF-C-050", "BF-C-066", "BF-C-074", "BF-C-075"],
  throughline: ["BF-C-075", "BF-C-076", "BF-C-077", "BF-C-078", "BF-C-079", "BF-C-080", "BF-C-081", "BF-C-082", "BF-C-083"]
};

const DEFAULT_EDITORIAL_METADATA = Object.fromEntries(Object.entries(FACT_IDS_BY_ROLE).flatMap(([role, ids]) => ids.map((id) => [id, role]))
  .reduce((map, [id, role]) => {
    const current = map.get(id) || { narrativeRoles: [] };
    current.narrativeRoles.push(role);
    map.set(id, current);
    return map;
  }, new Map()));

function publicEvidence(fact) {
  return {
    id: fact.id,
    claim: fact.claim,
    attribution: fact.attribution,
    topics: fact.topics,
    ...(fact.project_id ? { project_id: fact.project_id } : {}),
    ...(fact.career_context_id ? { career_context_id: fact.career_context_id } : {}),
    ...(fact.period ? { period: fact.period } : {})
  };
}

function topicOverlap(fact, topics) {
  return fact.topics.filter((topic) => topics.includes(topic)).length;
}

function orderedForTopics(facts, topics) {
  return [...facts].sort((left, right) => topicOverlap(right, topics) - topicOverlap(left, topics) || left.id.localeCompare(right.id));
}

function proofProjectIds(prose) {
  return [...new Set((prose?.sections || []).flatMap((section) => (section.proofItems || section.proof_items || [])
    .map((item) => item.projectId || item.project_id)
    .filter(Boolean)))];
}

export function buildEvaluatorEvidenceContext({ approvedFacts, editorialMetadata, selectedTopicIds = [], prose }) {
  const eligibleFacts = approvedFacts
    .filter((fact) => fact.visibility === "shareable" && ALLOWED_ATTRIBUTIONS.has(fact.attribution))
    .map(publicEvidence);

  const sharedNonProjectPool = orderedForTopics(
    eligibleFacts.filter((fact) => !fact.project_id),
    selectedTopicIds
  ).map((fact) => ({
    ...fact,
    legacy_narrative_roles: editorialMetadata[fact.id]?.narrativeRoles || []
  }));
  const eligibleEvidenceByProject = Object.fromEntries(proofProjectIds(prose).map((projectId) => [
    projectId,
    orderedForTopics(eligibleFacts.filter((fact) => fact.project_id === projectId), selectedTopicIds)
  ]));

  return {
    eligibleSharedFramingEvidence: sharedNonProjectPool,
    sharedFramingSectionIds: SECTION_IDS,
    eligibleEvidenceByProject
  };
}

export function buildDefaultEvaluatorEvidenceContext({ selectedTopicIds = [], prose }) {
  return buildEvaluatorEvidenceContext({
    approvedFacts: approvedCorpusJson.facts,
    editorialMetadata: DEFAULT_EDITORIAL_METADATA,
    selectedTopicIds,
    prose
  });
}
