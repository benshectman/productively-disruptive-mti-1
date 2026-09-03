import { describe, expect, it } from "vitest";
import legacy from "../src/content/legacy/ben-profile-v0.1-alpha.json";
import migrationV01 from "../src/content/candidates/ben-facts-migration.v0.1.json";
import migration from "../src/content/candidates/ben-facts-migration.v0.4.json";

describe("BenFacts migration boundary", () => {
  const legacyProfileEntries = Object.values(legacy.profile).flat();
  const legacyRecords = [...legacyProfileEntries, ...legacy.boundaries];
  const legacyCandidates = migration.candidates.filter((candidate) => "legacy" in candidate);
  const sourceIds = new Set(migration.sources.map((source) => source.source_id));

  it("preserves all 32 legacy records while adding source-derived candidates", () => {
    expect(legacyProfileEntries).toHaveLength(29);
    expect(legacy.boundaries).toHaveLength(3);
    expect(migrationV01.candidates).toHaveLength(32);
    expect(legacyCandidates).toHaveLength(32);
    expect(migration.summary.legacy_candidates).toBe(32);
    expect(migration.summary.source_derived_candidates).toBeGreaterThan(40);
    expect(migration.candidates).toHaveLength(migration.summary.total_candidates);
    expect(migration.summary.total_candidates).toBe(83);
    expect(migration.summary.source_derived_candidates).toBe(51);
  });

  it("adds the three Crestron career facts in v0.4", () => {
    const additions = migration.candidates.filter((candidate) => ["BF-C-081", "BF-C-082", "BF-C-083"].includes(candidate.candidate_id));
    expect(additions).toHaveLength(3);
    expect(additions.every((candidate) => candidate.target_type === "evidence_candidate")).toBe(true);
    expect(additions.every((candidate) => candidate.source_refs.some((source) => source.source_id === "SRC-BF-006"))).toBe(true);
  });

  it("preserves every legacy UUID and original wording exactly once", () => {
    const sourceUuids = legacyRecords.map((item) => item.uuid).sort();
    const migratedUuids = legacyCandidates.map((candidate) => candidate.legacy!.uuid).sort();
    expect(new Set(migratedUuids).size).toBe(32);
    expect(migratedUuids).toEqual(sourceUuids);

    const sourceByUuid = new Map(legacyRecords.map((item) => [item.uuid, item.content]));
    for (const candidate of legacyCandidates) {
      expect(candidate.original_text).toBe(sourceByUuid.get(candidate.legacy!.uuid));
    }
  });

  it("keeps every candidate outside the approved generation corpus", () => {
    expect(migration.meta.status).toBe("review_required");
    expect(migration.candidates.every((candidate) => candidate.status === "pending_review")).toBe(true);
    expect(migration.candidates.every((candidate) => !candidate.candidate_id.startsWith("E-"))).toBe(true);
  });

  it("registers all supplied sources and allows only the resume and AskGS case study to be shareable assets", () => {
    const suppliedSources = migration.sources.filter((source) => source.source_id !== "SRC-BENFACTS-001");
    const shareable = suppliedSources.filter((source) => source.shareable_asset).map((source) => source.filename).sort();

    expect(suppliedSources).toHaveLength(22);
    expect(shareable).toEqual([
      "AskGS Future State Analysis and Recommendations Case Study.pdf",
      "BenShectman_resume_2026.pdf"
    ]);
    expect(suppliedSources.filter((source) => !source.shareable_asset)).toHaveLength(20);
    expect(suppliedSources.every((source) => source.sha256.match(/^[a-f0-9]{64}$/))).toBe(true);
  });

  it("uses only valid, resolvable source references and locators", () => {
    for (const candidate of migration.candidates) {
      expect(candidate.source_refs.length).toBeGreaterThan(0);
      for (const sourceRef of candidate.source_refs) {
        expect(sourceIds.has(sourceRef.source_id)).toBe(true);
        for (const location of sourceRef.locations) {
          expect(["page", "slide"]).toContain(location.kind);
          expect(location.number).toBeGreaterThan(0);
        }
      }
    }
  });

  it("assigns the required evidence-strength scale to every candidate", () => {
    const validStrengths = ["1 - Poor", "2 - Fair", "3 - Good", "4 - Strong"];
    expect(migration.candidates.every((candidate) => validStrengths.includes(candidate.evidence_strength))).toBe(true);
    expect(migration.candidates.every((candidate) => candidate.evidence_strength_rationale.length > 20)).toBe(true);
    expect(migration.candidates.some((candidate) => candidate.source_refs.length > 2)).toBe(true);
  });

  it("scopes only cleanly single-project facts with stable project ids", () => {
    const projectFacts = migration.candidates.filter((candidate) => "project_id" in candidate);
    expect(projectFacts).toHaveLength(19);
    expect(projectFacts.every((candidate) => candidate.target_type === "project_candidate")).toBe(true);
    expect(projectFacts.every((candidate) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.project_id!))).toBe(true);
    expect(migration.candidates.find((candidate) => candidate.candidate_id === "BF-C-062")).not.toHaveProperty("project_id");
  });

  it("preserves leadership and team attribution for directed product work", () => {
    const sourceDerivedProjects = migration.candidates.filter(
      (candidate) => candidate.target_type === "project_candidate" && !("legacy" in candidate)
    );

    expect(sourceDerivedProjects.length).toBeGreaterThan(15);
    expect(sourceDerivedProjects.every((candidate) => ["leadership", "team"].includes(candidate.attribution))).toBe(true);
  });

  it("retains flags for known compound legacy statements", () => {
    const splitCandidates = legacyCandidates.filter((candidate) => candidate.review.atomicity_review === "split_required");
    expect(splitCandidates.map((candidate) => candidate.legacy!.slug)).toEqual(expect.arrayContaining([
      "directed-design-services-portfolio-exceeding-six-million-dollars",
      "directed-analytics-driven-initiatives",
      "professional-certifications"
    ]));
  });
});

