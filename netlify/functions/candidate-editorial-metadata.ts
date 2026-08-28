export type NarrativeRole = "about" | "recent_leadership" | "proof" | "throughline";
export type CareerPeriod = "career_wide" | "recent" | "earlier";
export type PortfolioSalience = "anchor" | "supporting" | "detail";
export type CandidateScope = "career_wide" | "organization" | "role" | "practice" | "project" | "outcome";

export type CandidateEditorialMetadata = {
  careerPeriod: CareerPeriod;
  portfolioSalience: PortfolioSalience;
  scope: CandidateScope;
  narrativeRoles: NarrativeRole[];
};

const recentPractice = (portfolioSalience: PortfolioSalience = "supporting"): CandidateEditorialMetadata => ({
  careerPeriod: "recent", portfolioSalience, scope: "practice", narrativeRoles: ["recent_leadership"]
});
const recentProject = (scope: "project" | "outcome" = "project", portfolioSalience: PortfolioSalience = "supporting"): CandidateEditorialMetadata => ({
  careerPeriod: "recent", portfolioSalience, scope, narrativeRoles: ["proof"]
});

/**
 * Provisional, server-only editorial guidance for the validation corpus.
 * It does not modify candidate facts or their review status and can be removed
 * without changing the underlying BenFacts compendium.
 */
export const candidateEditorialMetadata: Record<string, CandidateEditorialMetadata> = {
  "BF-C-033": { careerPeriod: "recent", portfolioSalience: "anchor", scope: "role", narrativeRoles: ["about", "recent_leadership"] },
  "BF-C-034": recentPractice("anchor"),
  "BF-C-035": recentPractice("anchor"),
  "BF-C-036": recentPractice("anchor"),
  "BF-C-037": recentPractice(),
  "BF-C-038": recentPractice("anchor"),
  "BF-C-039": recentPractice("anchor"),
  "BF-C-040": recentPractice(),
  "BF-C-041": recentPractice(),
  "BF-C-042": { careerPeriod: "recent", portfolioSalience: "supporting", scope: "organization", narrativeRoles: ["recent_leadership"] },
  "BF-C-043": { careerPeriod: "recent", portfolioSalience: "anchor", scope: "role", narrativeRoles: ["about", "recent_leadership"] },
  "BF-C-044": { careerPeriod: "recent", portfolioSalience: "supporting", scope: "organization", narrativeRoles: ["recent_leadership"] },
  "BF-C-045": { careerPeriod: "recent", portfolioSalience: "anchor", scope: "role", narrativeRoles: ["about", "recent_leadership"] },
  "BF-C-046": recentPractice("anchor"),
  "BF-C-047": recentPractice(),
  "BF-C-048": recentPractice(),
  "BF-C-049": { careerPeriod: "recent", portfolioSalience: "anchor", scope: "role", narrativeRoles: ["about", "recent_leadership"] },
  "BF-C-050": { careerPeriod: "recent", portfolioSalience: "supporting", scope: "organization", narrativeRoles: ["recent_leadership"] },
  "BF-C-051": recentProject(),
  "BF-C-052": recentProject("outcome"),
  "BF-C-053": recentProject("outcome", "anchor"),
  "BF-C-054": recentProject(),
  "BF-C-055": recentProject("project", "anchor"),
  "BF-C-056": recentProject("outcome", "anchor"),
  "BF-C-057": recentProject("project", "anchor"),
  "BF-C-058": recentProject("outcome", "detail"),
  "BF-C-059": recentProject("outcome", "detail"),
  "BF-C-060": recentProject("project", "anchor"),
  "BF-C-061": recentProject("outcome", "detail"),
  "BF-C-062": recentProject("project", "anchor"),
  "BF-C-063": recentProject(),
  "BF-C-064": recentProject("outcome", "detail"),
  "BF-C-065": recentProject("project", "anchor"),
  "BF-C-066": recentPractice(),
  "BF-C-067": recentProject(),
  "BF-C-068": recentProject("outcome", "anchor"),
  "BF-C-069": recentProject("project", "anchor"),
  "BF-C-070": recentProject("outcome", "detail"),
  "BF-C-071": recentProject(),
  "BF-C-072": recentProject(),
  "BF-C-073": { careerPeriod: "career_wide", portfolioSalience: "anchor", scope: "career_wide", narrativeRoles: ["about"] },
  "BF-C-074": { careerPeriod: "recent", portfolioSalience: "anchor", scope: "practice", narrativeRoles: ["about", "recent_leadership"] },
  "BF-C-075": { careerPeriod: "recent", portfolioSalience: "supporting", scope: "practice", narrativeRoles: ["recent_leadership", "throughline"] },
  "BF-C-076": { careerPeriod: "career_wide", portfolioSalience: "anchor", scope: "career_wide", narrativeRoles: ["about", "throughline"] },
  "BF-C-077": { careerPeriod: "earlier", portfolioSalience: "anchor", scope: "role", narrativeRoles: ["throughline"] },
  "BF-C-078": { careerPeriod: "earlier", portfolioSalience: "anchor", scope: "role", narrativeRoles: ["throughline"] },
  "BF-C-079": { careerPeriod: "earlier", portfolioSalience: "anchor", scope: "role", narrativeRoles: ["throughline"] },
  "BF-C-080": { careerPeriod: "earlier", portfolioSalience: "supporting", scope: "career_wide", narrativeRoles: ["throughline"] }
};

