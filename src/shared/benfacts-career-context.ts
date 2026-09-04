import type { BenFactReview, BenFactsReviewCorpus } from "./benfacts-review";

export type CareerContext = {
  id: string;
  organization: string;
  display_name: string;
  start_year: number;
  end_year: number;
};

export const careerContexts: CareerContext[] = [
  { id: "jnj-2019-2025", organization: "Johnson & Johnson", display_name: "J&J", start_year: 2019, end_year: 2025 },
  { id: "crestron-2016-2018", organization: "Crestron Electronics", display_name: "Crestron", start_year: 2016, end_year: 2018 },
  { id: "redi-2015", organization: "REDI Global Technologies", display_name: "REDI", start_year: 2015, end_year: 2015 },
  { id: "sparta-2012-2014", organization: "Sparta Systems", display_name: "Sparta", start_year: 2012, end_year: 2014 },
  { id: "emc-2011-2012", organization: "EMC2 Global Consulting", display_name: "EMC2 Global Consulting", start_year: 2011, end_year: 2012 },
  { id: "pfizer-2006-2011", organization: "Pfizer", display_name: "Pfizer", start_year: 2006, end_year: 2011 },
  { id: "businessedge-2005-2006", organization: "BusinessEdge Solutions", display_name: "BusinessEdge", start_year: 2005, end_year: 2006 },
  { id: "omnimodis-ox-2001-2005", organization: "OmniModis Design / OX Interactive", display_name: "OmniModis / OX", start_year: 2001, end_year: 2005 },
  { id: "mainspring-2000-2001", organization: "Mainspring (an IBM Company)", display_name: "Mainspring", start_year: 2000, end_year: 2001 }
];

const contextGroups: Record<string, string[]> = {
  "jnj-2019-2025": [
    "BF-C-004","BF-C-005","BF-C-006","BF-C-007","BF-C-009","BF-C-012","BF-C-033","BF-C-034","BF-C-035","BF-C-036","BF-C-037","BF-C-038","BF-C-039","BF-C-040","BF-C-041","BF-C-042","BF-C-043","BF-C-045","BF-C-046","BF-C-047","BF-C-048","BF-C-049","BF-C-050","BF-C-051","BF-C-052","BF-C-053","BF-C-054","BF-C-055","BF-C-056","BF-C-057","BF-C-058","BF-C-059","BF-C-060","BF-C-062","BF-C-063","BF-C-065","BF-C-066","BF-C-067","BF-C-068","BF-C-069","BF-C-071","BF-C-072","BF-C-073","BF-C-074","BF-C-075","BF-C-008A","BF-C-008B","BF-C-011A","BF-C-011B","BF-C-044R","BF-C-061R","BF-C-064A","BF-C-064B","BF-C-064C","BF-C-070R","BF-X-001","BF-X-002","BF-X-003","BF-X-005","BF-X-007","BF-X-008","BF-X-011","BF-X-012","BF-X-013","BF-X-014","BF-X-015","BF-X-016","BF-X-017","BF-X-018","BF-X-019","BF-X-020","BF-X-021","BF-X-022","BF-X-023","BF-X-024","BF-X-025","BF-X-026","BF-X-027","BF-X-029","BF-X-030","BF-X-031","BF-X-032","BF-X-034","BF-X-035","BF-X-036","BF-X-037","BF-X-039","BF-X-040","BF-X-041","BF-X-042","BF-X-043","BF-X-044","BF-X-045","BF-X-046","BF-X-047","BF-X-048","BF-X-050","BF-X-051","BF-X-052","BF-X-053","BF-X-054","BF-X-055","BF-X-056","BF-X-057","BF-X-058","BF-X-060","BF-X-061"
  ],
  "crestron-2016-2018": ["BF-C-017","BF-C-077","BF-X-062","BF-X-063"],
  "redi-2015": ["BF-C-018","BF-C-078","BF-X-064","BF-X-065","BF-X-066","BF-X-067","BF-X-068"],
  "sparta-2012-2014": ["BF-C-019","BF-C-079","BF-X-069","BF-X-070","BF-X-071","BF-X-072","BF-X-073"],
  "emc-2011-2012": ["BF-C-020"],
  "pfizer-2006-2011": ["BF-C-021A"],
  "businessedge-2005-2006": ["BF-C-080A"],
  "omnimodis-ox-2001-2005": ["BF-C-080B"],
  "mainspring-2000-2001": ["BF-C-080C"]
};

const periods: Record<string, NonNullable<BenFactReview["period"]>> = {
  "BF-C-004": { start_year: 2019, end_year: 2025 },
  "BF-C-018": { start_year: 2015, end_year: 2015 },
  "BF-C-033": { start_year: 2019, end_year: 2019 },
  "BF-C-034": { start_year: 2020, end_year: 2020 },
  "BF-C-040": { start_year: 2022, end_year: 2022 },
  "BF-C-042": { start_year: 2025, end_year: 2025 },
  "BF-C-043": { start_year: 2025, end_year: 2025 },
  "BF-C-050": { start_year: 2020, end_year: 2020 },
  "BF-C-057": { start_year: 2023, end_year: 2023 },
  "BF-C-058": { start_year: 2023, end_year: 2023 },
  "BF-C-059": { start_year: 2023, end_year: 2023 },
  "BF-C-062": { start_year: 2022, end_year: 2024 },
  "BF-C-063": { start_year: 2023, end_year: 2023 },
  "BF-C-067": { start_year: 2023, end_year: 2023 },
  "BF-C-068": { start_year: 2023, end_year: 2023 },
  "BF-C-071": { start_year: 2023, end_year: 2023 },
  "BF-C-075": { start_year: 2025, end_year: 2025 },
  "BF-C-078": { start_year: 2015, end_year: 2015 },
  "BF-C-064A": { start_year: 2023, end_year: 2023 },
  "BF-C-064B": { start_year: 2023, end_year: 2023 },
  "BF-C-064C": { start_year: 2023, end_year: 2023 },
  "BF-X-001": { start_year: 2020, end_year: 2020 },
  "BF-X-002": { start_year: 2020, end_year: 2020 },
  "BF-X-007": { start_year: 2022, end_year: 2022 },
  "BF-X-008": { start_year: 2022, end_year: 2022 },
  "BF-X-011": { start_year: 2025, end_year: 2025 },
  "BF-X-012": { start_year: 2025, end_year: 2025 },
  "BF-X-013": { start_year: 2025, end_year: 2025 },
  "BF-X-014": { start_year: 2025, end_year: 2025 },
  "BF-X-015": { start_year: 2025, end_year: 2025 },
  "BF-X-016": { start_year: 2025, end_year: 2025 },
  "BF-X-017": { start_year: 2025, end_year: 2025 },
  "BF-X-018": { start_year: 2025, end_year: 2025 },
  "BF-X-019": { start_year: 2025, end_year: 2025 },
  "BF-X-020": { start_year: 2025, end_year: 2025 },
  "BF-X-050": { start_year: 2023, end_year: 2023 },
  "BF-X-052": { start_year: 2023, end_year: 2023 },
  "BF-X-057": { start_year: 2022, end_year: 2024 },
  "BF-X-060": { start_year: 2022, end_year: 2024 },
  "BF-X-061": { start_year: 2022, end_year: 2024 },
  "BF-X-064": { start_year: 2015, end_year: 2015 },
  "BF-X-065": { start_year: 2015, end_year: 2015 },
  "BF-X-066": { start_year: 2015, end_year: 2015 },
  "BF-X-067": { start_year: 2015, end_year: 2015 },
  "BF-X-068": { start_year: 2015, end_year: 2015 }
};

const defaultContextByCandidate = new Map<string, string>();
for (const [contextId, candidateIds] of Object.entries(contextGroups)) {
  for (const candidateId of candidateIds) defaultContextByCandidate.set(candidateId, contextId);
}

export function careerContextById(id?: string) {
  return id ? careerContexts.find((context) => context.id === id) : undefined;
}

export function applyCareerContextDefaults(corpus: BenFactsReviewCorpus): BenFactsReviewCorpus {
  return {
    ...corpus,
    candidates: corpus.candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.career_context_id ? {} : defaultContextByCandidate.has(candidate.candidate_id) ? { career_context_id: defaultContextByCandidate.get(candidate.candidate_id) } : {}),
      ...(candidate.period ? {} : periods[candidate.candidate_id] ? { period: periods[candidate.candidate_id] } : {})
    }))
  };
}

export function validateCareerPeriod(record: Pick<BenFactReview, "career_context_id" | "period">): string | null {
  const { period } = record;
  if (!period) return null;
  const { start_year, end_year } = period;
  if (start_year !== undefined && end_year !== undefined && start_year > end_year) return "Specific period start year cannot be after end year.";
  const context = careerContextById(record.career_context_id);
  if (!context) return record.career_context_id ? "The selected career context is not recognized." : "Choose a career context before adding a specific period.";
  if (start_year !== undefined && (start_year < context.start_year || start_year > context.end_year)) return `Start year must fall within ${context.start_year}–${context.end_year}.`;
  if (end_year !== undefined && (end_year < context.start_year || end_year > context.end_year)) return `End year must fall within ${context.start_year}–${context.end_year}.`;
  return null;
}
