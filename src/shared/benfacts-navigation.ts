import type { BenFactReview, ReviewStatus } from "./benfacts-review";
import type { TopicId } from "./contracts";

export type BenFactsFilters = {
  status: ReviewStatus | "all";
  topic: TopicId | "all";
  project: string;
  attribution: BenFactReview["attribution"] | "all";
  origin: BenFactReview["origin"] | "all";
};

export function filterBenFacts(candidates: BenFactReview[], filters: BenFactsFilters) {
  return candidates.filter((item) =>
    (filters.status === "all" || item.review_status === filters.status) &&
    (filters.topic === "all" || item.topics.includes(filters.topic)) &&
    (filters.project === "all" || (filters.project === "none" ? !item.project_id : item.project_id === filters.project)) &&
    (filters.attribution === "all" || item.attribution === filters.attribution) &&
    (filters.origin === "all" || item.origin === filters.origin)
  );
}

export function reconcileCurrentFactId(currentId: string, filtered: BenFactReview[]) {
  if (!filtered.length || filtered.some((item) => item.candidate_id === currentId)) return currentId;
  return filtered[0].candidate_id;
}
