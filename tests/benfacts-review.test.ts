import { describe, expect, it } from "vitest";
import reviewJson from "../src/content/review/ben-facts-review.v1.json";
import { BenFactsReviewCorpusSchema } from "../src/shared/benfacts-review";
import { filterBenFacts, reconcileCurrentFactId, type BenFactsFilters } from "../src/shared/benfacts-navigation";
import { promoteApprovedFacts } from "../src/shared/benfacts-promotion";
import { similarFacts, similarityScore } from "../src/shared/benfacts-similarity";

const corpus = BenFactsReviewCorpusSchema.parse(reviewJson);
const allFilters: BenFactsFilters = { status: "all", topic: "all", project: "all", attribution: "all", origin: "all" };

describe("BenFacts review corpus", () => {
  it("contains 147 unique candidates and none begin approved", () => {
    expect(corpus.candidates).toHaveLength(147);
    expect(new Set(corpus.candidates.map((item) => item.candidate_id)).size).toBe(147);
    expect(corpus.candidates.every((item) => item.review_status === "unreviewed")).toBe(true);
  });

  it("preserves original wording and source references through an edit", () => {
    const original = corpus.candidates.find((item) => item.source_refs.length)!;
    const edited = { ...original, reviewed_text: "Reviewed wording.", review_status: "approved" as const };
    expect(edited.original_text).toBe(original.original_text);
    expect(edited.source_refs).toEqual(original.source_refs);
    expect(BenFactsReviewCorpusSchema.shape.candidates.element.parse(edited)).toEqual(edited);
  });
});

describe("approved corpus promotion", () => {
  it("promotes only approved records and uses reviewed wording", () => {
    const statuses = ["approved", "hold", "rejected", "unreviewed"] as const;
    const candidates = corpus.candidates.map((item, index) => index < statuses.length ? { ...item, reviewed_text: `${item.reviewed_text} reviewed`, review_status: statuses[index] } : item);
    const promoted = promoteApprovedFacts({ ...corpus, candidates });
    expect(promoted.facts).toHaveLength(1);
    expect(promoted.facts[0].id).toBe(candidates[0].candidate_id);
    expect(promoted.facts[0].claim).toBe(candidates[0].reviewed_text);
    expect(promoted.meta.approved_count).toBe(1);
  });
});

describe("similar items", () => {
  it("is deterministic, excludes the current fact, and strongly weights same-project records", () => {
    const projectFacts = corpus.candidates.filter((item) => item.project_id && corpus.candidates.filter((candidate) => candidate.project_id === item.project_id).length > 1);
    const current = projectFacts[0];
    const sameProject = projectFacts.find((item) => item.candidate_id !== current.candidate_id && item.project_id === current.project_id)!;
    const unrelated = corpus.candidates.find((item) => item.candidate_id !== current.candidate_id && item.project_id !== current.project_id && !item.topics.some((topic) => current.topics.includes(topic)))!;
    expect(similarityScore(current, sameProject)).toBeGreaterThan(similarityScore(current, unrelated));
    const first = similarFacts(current, corpus.candidates);
    const second = similarFacts(current, corpus.candidates);
    expect(first).toEqual(second);
    expect(first.some((item) => item.candidate_id === current.candidate_id)).toBe(false);
  });
});

describe("filtered navigation", () => {
  it("keeps the current fact when it belongs to the filtered result set", () => {
    const current = corpus.candidates[0];
    const filtered = filterBenFacts(corpus.candidates, { ...allFilters, origin: current.origin });
    expect(reconcileCurrentFactId(current.candidate_id, filtered)).toBe(current.candidate_id);
  });

  it("moves to the first match when the current fact is outside the filtered result set", () => {
    const baseline = corpus.candidates.find((item) => item.origin === "baseline")!;
    const filtered = filterBenFacts(corpus.candidates, { ...allFilters, origin: "expansion" });
    expect(filtered.length).toBeGreaterThan(0);
    expect(reconcileCurrentFactId(baseline.candidate_id, filtered)).toBe(filtered[0].candidate_id);
  });

  it("keeps the current fact when no facts match", () => {
    const current = corpus.candidates[0];
    const filtered = filterBenFacts(corpus.candidates, { ...allFilters, project: "missing-project" });
    expect(filtered).toHaveLength(0);
    expect(reconcileCurrentFactId(current.candidate_id, filtered)).toBe(current.candidate_id);
  });
});
