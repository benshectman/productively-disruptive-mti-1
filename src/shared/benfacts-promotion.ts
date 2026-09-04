import type { BenFactsReviewCorpus } from "./benfacts-review";

export function promoteApprovedFacts(review: BenFactsReviewCorpus) {
  const facts = review.candidates.filter((candidate) => candidate.review_status === "approved").map((candidate) => ({
    id: candidate.candidate_id,
    claim: candidate.reviewed_text,
    attribution: candidate.attribution,
    topics: candidate.topics,
    ...(candidate.project_id ? { project_id: candidate.project_id } : {}),
    ...(candidate.career_context_id ? { career_context_id: candidate.career_context_id } : {}),
    ...(candidate.period ? { period: candidate.period } : {}),
    visibility: candidate.visibility,
    source_refs: candidate.source_refs
  }));
  return { meta: { version: "1.0", generated_from: "ben-facts-review.v1.json", approved_count: facts.length }, facts };
}
