import { describe, expect, it } from "vitest";
import legacy from "../src/content/legacy/ben-profile-v0.1-alpha.json";
import migration from "../src/content/candidates/ben-facts-migration.v0.1.json";

describe("BenFacts migration boundary", () => {
  const legacyProfileEntries = Object.values(legacy.profile).flat();

  it("accounts for every legacy profile fact and policy boundary", () => {
    expect(legacyProfileEntries).toHaveLength(29);
    expect(legacy.boundaries).toHaveLength(3);
    expect(migration.candidates).toHaveLength(32);
    expect(migration.summary.profile_candidates).toBe(29);
    expect(migration.summary.policy_candidates).toBe(3);
  });

  it("preserves every legacy UUID exactly once", () => {
    const sourceIds = [...legacyProfileEntries, ...legacy.boundaries].map((item) => item.uuid).sort();
    const migratedIds = migration.candidates.map((candidate) => candidate.legacy.uuid).sort();
    expect(new Set(migratedIds).size).toBe(32);
    expect(migratedIds).toEqual(sourceIds);
  });

  it("keeps all candidates out of the approved generation corpus", () => {
    expect(migration.meta.status).toBe("review_required");
    expect(migration.source.authority).toBe("unverified_migration_source");
    expect(migration.source.visibility).toBe("knowledge_only");
    expect(migration.candidates.every((candidate) => candidate.status === "pending_review")).toBe(true);
    expect(migration.candidates.every((candidate) => !candidate.candidate_id.startsWith("E-"))).toBe(true);
  });

  it("preserves original wording for review", () => {
    const sourceByUuid = new Map([...legacyProfileEntries, ...legacy.boundaries].map((item) => [item.uuid, item.content]));
    for (const candidate of migration.candidates) expect(candidate.original_text).toBe(sourceByUuid.get(candidate.legacy.uuid));
  });

  it("flags known compound statements for splitting", () => {
    const splitCandidates = migration.candidates.filter((candidate) => candidate.review.atomicity_review === "split_required");
    expect(splitCandidates.map((candidate) => candidate.legacy.slug)).toEqual(expect.arrayContaining([
      "directed-design-services-portfolio-exceeding-six-million-dollars",
      "directed-analytics-driven-initiatives",
      "professional-certifications"
    ]));
  });
});
