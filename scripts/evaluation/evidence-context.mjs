const ALLOWED_ATTRIBUTIONS = new Set(["personal", "leadership", "team", "organization", "shared_leadership"]);

const SECTION_ROLES = {
  "system-behind-design": "about",
  "operating-model": "recent_leadership",
  "institutionalized-capability": "throughline"
};

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

  const eligibleEvidenceBySection = Object.fromEntries(Object.entries(SECTION_ROLES).map(([sectionId, role]) => [
    sectionId,
    orderedForTopics(
      eligibleFacts.filter((fact) => editorialMetadata[fact.id]?.narrativeRoles?.includes(role)),
      selectedTopicIds
    )
  ]));

  const eligibleEvidenceByProject = Object.fromEntries(proofProjectIds(prose).map((projectId) => [
    projectId,
    orderedForTopics(eligibleFacts.filter((fact) => fact.project_id === projectId), selectedTopicIds)
  ]));

  return { eligibleEvidenceBySection, eligibleEvidenceByProject };
}
