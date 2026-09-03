import candidateManifestJson from "../../src/content/candidates/ben-facts-migration.v0.3.json";
import { NarrativeSchema, ProofItemSchema, type Attribution, type Narrative, type ProofItem, type ProofResultType, type PublicEvidence, type TopicId } from "../../src/shared/contracts";
import { candidateEditorialMetadata, type NarrativeRole } from "./candidate-editorial-metadata";
import { expandPresentationAcronyms } from "../../src/shared/narrative-presentation";

type CandidateRecord = {
  candidate_id: string;
  target_type: string;
  original_text: string;
  proposed_topics: TopicId[];
  status: "pending_review";
  visibility: string;
  attribution: Attribution | "undetermined" | "policy";
  evidence_strength: "1 - Poor" | "2 - Fair" | "3 - Good" | "4 - Strong";
  project_id?: string;
};

const candidateManifest = candidateManifestJson as unknown as { candidates: CandidateRecord[] };
const allowedAttributions = new Set<Attribution>(["personal", "leadership", "team", "organization", "shared_leadership"]);
const allowedTypes = new Set(["proposition_candidate", "evidence_candidate", "project_candidate", "career_record_candidate", "credential_candidate"]);

const candidates = candidateManifest.candidates.filter((candidate) =>
  Number(candidate.candidate_id.slice(-3)) >= 33
  && candidate.status === "pending_review"
  && allowedTypes.has(candidate.target_type)
  && allowedAttributions.has(candidate.attribution as Attribution)
);
const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
export const candidateValidationIds = new Set(candidateById.keys());

const PROJECT_NAMES: Record<string, string> = {
  askgs: "AskGS",
  spr: "Service Performance Reporting",
  vital: "Vital",
  "emarketplace-purchasing": "Enterprise purchasing experience",
  "supplier-risk-sensing": "Supplier Risk Sensing",
  "comet-change-control": "Comet Change Control",
  "first-tpi-due-diligence": "FIRST third-party due diligence",
  pqm360: "PQM360",
  xiam: "External identity and access management"
};

const TOPIC_LABELS: Record<TopicId, string> = {
  "T-001": "Design Leadership",
  "T-002": "Systems Thinking",
  "T-003": "Enterprise UX",
  "T-004": "UX Measurement"
};

const PRACTICE_ANCHORS: Record<TopicId, string[]> = {
  "T-001": ["BF-C-049", "BF-C-050", "BF-C-066", "BF-C-044"],
  "T-002": ["BF-C-036", "BF-C-037", "BF-C-041", "BF-C-046", "BF-C-047", "BF-C-048"],
  "T-003": ["BF-C-045", "BF-C-034", "BF-C-036", "BF-C-042"],
  "T-004": ["BF-C-038", "BF-C-039", "BF-C-047", "BF-C-074", "BF-C-075"]
};

const PROJECT_ANCHORS: Record<TopicId, string[]> = {
  "T-001": ["BF-C-053", "BF-C-062", "BF-C-060", "BF-C-067"],
  "T-002": ["BF-C-055", "BF-C-065", "BF-C-069", "BF-C-071"],
  "T-003": ["BF-C-053", "BF-C-057", "BF-C-060", "BF-C-062", "BF-C-069", "BF-C-072"],
  "T-004": ["BF-C-051", "BF-C-054", "BF-C-056", "BF-C-058", "BF-C-068", "BF-C-070"]
};

export type CandidateProofProject = {
  project_id: string;
  project_name: string;
  relevance: string;
  facts: CandidateRecord[];
};

const actionPattern = /\b(used|conducted|researched|embedded|prototyped|surveyed|combined|directed|redesign|workshops|aligned|analyzed|prepared|worked|produced|led)\b/i;
const outcomePattern = /\b(helped|informed|reported|recommendations?|increase|improvement|results?|save|produced|development-ready|backlog|scores?|rose|reaching|used by)\b/i;

function resultTypeFor(record: CandidateRecord): ProofResultType {
  const claim = record.original_text;
  if (/\$|save .*annually|financial/i.test(claim)) return "financial_impact";
  if (/decid|vendor|re-platform/i.test(claim)) return "business_decision";
  if (/usability|ease.of.use|usefulness|Net Promoter|response-rate|response rate/i.test(claim)) return "experience_measurement";
  if (/recommendations?|frustration themes|research program/i.test(claim)) return "research_output";
  if (/development-ready|design specification|prototype|interface designs|backlog/i.test(claim)) return "delivery_output";
  if (/users?|people|countries|languages|adoption|reach/i.test(claim)) return "adoption_or_reach";
  return "other_documented_outcome";
}

function proofSummary(records: CandidateRecord[]) {
  const explicitOutcomes = records.filter((record) => candidateEditorialMetadata[record.candidate_id]?.scope === "outcome");
  const inferredOutcomes = records.filter((record) => outcomePattern.test(record.original_text));
  const outcomePool = explicitOutcomes.length ? explicitOutcomes : inferredOutcomes.length ? inferredOutcomes : records;
  const inRangeOutcome = outcomePool.filter((record) => {
    const words = record.original_text.trim().split(/\s+/).length;
    return words >= 25 && words <= 45;
  });
  const primary = (inRangeOutcome.length ? inRangeOutcome : outcomePool)
    .sort((a, b) => strengthScore(b.evidence_strength) - strengthScore(a.evidence_strength))[0];
  const primaryWords = primary.original_text.trim().split(/\s+/).length;
  if (primaryWords >= 25 && primaryWords <= 45) {
    return { narrative: primary.original_text, evidence_fact_ids: [primary.candidate_id] };
  }

  const action = records.find((record) => record !== primary && actionPattern.test(record.original_text));
  if (action) {
    const first = action.original_text.replace(/[.!?]+$/, "");
    const second = primary.original_text.replace(/^([A-Z])/, (letter) => letter.toLowerCase());
    const combined = `${first}; ${second}`;
    const words = combined.trim().split(/\s+/).length;
    if (words >= 25 && words <= 45) {
      return { narrative: combined, evidence_fact_ids: [action.candidate_id, primary.candidate_id] };
    }
  }

  const fallback = records.find((record) => {
    const words = record.original_text.trim().split(/\s+/).length;
    return words >= 25 && words <= 45;
  }) || primary;
  return { narrative: fallback.original_text, evidence_fact_ids: [fallback.candidate_id] };
}

function relevanceFor(records: CandidateRecord[], topics: TopicId[]) {
  if (!topics.length) return "Selected as a strong, complete example for a balanced portfolio view.";
  const matching = topics.filter((topic) => records.some((record) => record.proposed_topics.includes(topic)));
  const labels = matching.map((topic) => TOPIC_LABELS[topic]);
  return labels.length ? `Selected for its relevance to ${labels.join(" and ")}.` : "Selected as a complementary proof point.";
}

function projectScore(project: CandidateProofProject, topics: TopicId[]) {
  const topicRelevance = topics.reduce((score, topic) => score + project.facts.filter((record) => record.proposed_topics.includes(topic)).length, 0);
  const outcomes = project.facts.filter((record) => candidateEditorialMetadata[record.candidate_id]?.scope === "outcome" || outcomePattern.test(record.original_text));
  const outcomeStrength = outcomes.reduce((score, record) => score + strengthScore(record.evidence_strength), 0);
  const recency = Math.max(...project.facts.map((record) => periodScore[candidateEditorialMetadata[record.candidate_id]?.careerPeriod || "earlier"]));
  const evidenceCompleteness = project.facts.length * 10
    + (project.facts.some((record) => actionPattern.test(record.original_text)) ? 5 : 0)
    + (outcomes.length ? 5 : 0);
  return [topicRelevance, outcomeStrength, recency, evidenceCompleteness] as const;
}

export function selectCandidateProofProjects(topics: TopicId[], limit = 3): CandidateProofProject[] {
  const grouped = new Map<string, CandidateRecord[]>();
  for (const record of candidates) {
    if (record.target_type !== "project_candidate" || !record.project_id || !PROJECT_NAMES[record.project_id]) continue;
    grouped.set(record.project_id, [...(grouped.get(record.project_id) || []), record]);
  }
  return [...grouped.entries()].map(([project_id, facts]) => ({
    project_id,
    project_name: PROJECT_NAMES[project_id],
    relevance: relevanceFor(facts, topics),
    facts: facts.sort((a, b) => a.candidate_id.localeCompare(b.candidate_id))
  })).sort((a, b) => {
    const left = projectScore(a, topics);
    const right = projectScore(b, topics);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return right[index] - left[index];
    }
    return a.project_id.localeCompare(b.project_id);
  }).slice(0, limit);
}

export function buildCandidateProofItem(project: CandidateProofProject): ProofItem {
  const situationRecord = project.facts[0];
  const taskRecord = project.facts.find((record) => actionPattern.test(record.original_text)) || situationRecord;
  const actionRecords = project.facts.filter((record) => actionPattern.test(record.original_text));
  const resultRecords = project.facts.filter((record) => candidateEditorialMetadata[record.candidate_id]?.scope === "outcome" || outcomePattern.test(record.original_text));
  const item = {
    project_id: project.project_id,
    project_name: project.project_name,
    relevance: project.relevance,
    situation: { narrative: situationRecord.original_text, evidence_fact_ids: [situationRecord.candidate_id] },
    task: { narrative: taskRecord.original_text, evidence_fact_ids: [taskRecord.candidate_id] },
    actions: (actionRecords.length ? actionRecords : [taskRecord]).map((record) => ({
      action: record.original_text,
      evidence_fact_ids: [record.candidate_id]
    })),
    results: (resultRecords.length ? resultRecords : [project.facts.at(-1)!]).map((record) => ({
      result: record.original_text,
      result_type: resultTypeFor(record),
      evidence_fact_ids: [record.candidate_id]
    })),
    summary: proofSummary(project.facts)
  };
  return ProofItemSchema.parse(item);
}

export function proofItemEvidenceIds(item: ProofItem) {
  return [...new Set([
    ...item.situation.evidence_fact_ids,
    ...item.task.evidence_fact_ids,
    ...item.actions.flatMap((action) => action.evidence_fact_ids),
    ...item.results.flatMap((result) => result.evidence_fact_ids),
    ...item.summary.evidence_fact_ids
  ])];
}

export function validateProofItemProjectEvidence(item: ProofItem): boolean {
  const canonicalName = PROJECT_NAMES[item.project_id];
  return canonicalName === item.project_name && proofItemEvidenceIds(item).every((id) => {
    const record = candidateById.get(id);
    return Boolean(record && record.project_id === item.project_id);
  });
}

export function validateNarrativeProofProjects(narrative: Narrative): boolean {
  return narrative.sections.every((section) => {
    if (!section.proof_items) return true;
    const sectionIds = new Set(section.evidenceRefs);
    return section.id === "proof-to-scale" && section.proof_items.every((item) =>
      validateProofItemProjectEvidence(item) && proofItemEvidenceIds(item).every((id) => sectionIds.has(id))
    );
  });
}

const strengthScore = (strength: CandidateRecord["evidence_strength"]) => Number(strength[0]);
const topicScore = (candidate: CandidateRecord, topics: TopicId[]) =>
  candidate.proposed_topics.filter((topic) => topics.includes(topic)).length * 100 + strengthScore(candidate.evidence_strength) * 10;

function preferredIds(anchors: Record<TopicId, string[]>, topics: TopicId[], balanced: string[]) {
  return topics.length ? topics.flatMap((topic) => anchors[topic]) : balanced;
}

function pickCandidates(preferred: string[], types: string[], topics: TopicId[], count: number, used: Set<string>) {
  const typeSet = new Set(types);
  const preferredRecords = preferred.map((id) => candidateById.get(id)).filter((item): item is CandidateRecord => Boolean(item));
  const rankedPool = candidates
    .filter((candidate) => typeSet.has(candidate.target_type))
    .sort((a, b) => topicScore(b, topics) - topicScore(a, topics) || a.candidate_id.localeCompare(b.candidate_id));
  const selected: CandidateRecord[] = [];
  for (const candidate of [...preferredRecords, ...rankedPool]) {
    if (selected.length === count) break;
    if (used.has(candidate.candidate_id) || !typeSet.has(candidate.target_type)) continue;
    if (topics.length && !candidate.proposed_topics.some((topic) => topics.includes(topic)) && selected.length > 0) continue;
    used.add(candidate.candidate_id);
    selected.push(candidate);
  }
  return selected;
}

function boundedText(records: CandidateRecord[], max: number) {
  const text = records.map((record) => record.original_text).join(" ");
  if (text.length <= max) return text;
  const shortened = text.slice(0, max - 1);
  return `${shortened.slice(0, shortened.lastIndexOf(" "))}…`;
}

function editorialCopy(records: CandidateRecord[], bridge = "", leadRecord = records[0]) {
  // One intact fact introduces the section; other selected facts provide depth.
  // Do not shorten claims by cutting sentences, metrics, or attribution.
  return {
    summary: expandPresentationAcronyms(`${bridge} ${leadRecord.original_text}`.trim()),
    detail: records.filter((record) => record !== leadRecord)
      .map((record) => expandPresentationAcronyms(record.original_text)).join("\n\n")
  };
}

export function publicCandidateEvidence(ids?: Iterable<string>): PublicEvidence[] {
  const selectedIds = ids ? new Set(ids) : candidateValidationIds;
  return candidates.filter((candidate) => selectedIds.has(candidate.candidate_id)).map((candidate) => ({
    id: candidate.candidate_id,
    claim: candidate.original_text,
    attribution: candidate.attribution as Attribution,
    topics: candidate.proposed_topics
  }));
}

export function candidateValidationEnabled() {
  // Temporary experiment default. Set the runtime variable to "approved" or
  // change this default after the validation period to restore approved-only generation.
  return (process.env.BENFACTS_VALIDATION_MODE || "candidates").trim().toLowerCase() === "candidates";
}

export type CandidatePlannerMode = "legacy" | "editorial";

export function candidateNarrativePlannerMode(): CandidatePlannerMode {
  return (process.env.NARRATIVE_PLANNER_MODE || "editorial").trim().toLowerCase() === "legacy" ? "legacy" : "editorial";
}

export function assembleLegacyCandidateNarrative(topics: TopicId[]): Narrative {
  const used = new Set<string>();
  const about = pickCandidates(
    ["BF-C-073", ...(topics.flatMap((topic) => PRACTICE_ANCHORS[topic])), "BF-C-076", "BF-C-033", "BF-C-043"],
    ["proposition_candidate", "evidence_candidate"], topics, 3, used
  );
  const practice = pickCandidates(
    preferredIds(PRACTICE_ANCHORS, topics, ["BF-C-036", "BF-C-037", "BF-C-038", "BF-C-039", "BF-C-046", "BF-C-047"]),
    ["evidence_candidate"], topics, 4, used
  );
  const proofItems = selectCandidateProofProjects(topics).map(buildCandidateProofItem);
  const projects = proofItems.flatMap(proofItemEvidenceIds);
  const throughline = pickCandidates(
    ["BF-C-076", "BF-C-077", "BF-C-078", "BF-C-079", "BF-C-080", "BF-C-075", "BF-C-074"],
    ["evidence_candidate", "career_record_candidate", "credential_candidate"], topics, 3, used
  );

  const labels = topics.map((topic) => TOPIC_LABELS[topic]);
  const emphasis = labels.length ? labels.join(" + ") : "leadership, systems, enterprise experience, and measurement";
  const sections = [
    {
      id: "system-behind-design", purpose: "proposition" as const, eyebrow: "About Ben",
      headline: labels.length ? `A career viewed through ${emphasis}` : "A career spent making complexity workable",
      summary: boundedText(about.slice(0, 2), 900), evidenceRefs: about.map((item) => item.candidate_id), disclosure: "inline" as const,
      detail: boundedText(about, 1600)
    },
    {
      id: "operating-model", purpose: "evidence" as const, eyebrow: "Recent leadership",
      headline: topics.includes("T-004") ? "Measurement as part of the design system" : topics.includes("T-002") ? "Designing the conditions for good design" : "How the practice takes shape",
      summary: boundedText(practice.slice(0, 2), 900), evidenceRefs: practice.map((item) => item.candidate_id), disclosure: "none" as const
    },
    {
      id: "institutionalized-capability", purpose: "story" as const, eyebrow: "Career throughline",
      headline: "A throughline across products and organizations",
      summary: boundedText(throughline.slice(0, 2), 900), evidenceRefs: throughline.map((item) => item.candidate_id), disclosure: "none" as const
    },
    {
      id: "proof-to-scale", purpose: "transition" as const, eyebrow: "Proof in practice",
      headline: labels.length ? `${emphasis} in the work` : "Selected work, grounded in outcomes",
      summary: "Selected projects connect a specific challenge and response to a documented outcome.",
      detail: "Each proof point keeps its supporting situation, actions, and results within one project provenance boundary.",
      evidenceRefs: [...new Set(projects)], proof_items: proofItems, disclosure: "deep-dive" as const
    }
  ];
  return NarrativeSchema.parse({ sections, mode: "deterministic", grounding: "candidate_validation" });
}

const salienceScore = { anchor: 90, supporting: 45, detail: 10 } as const;
const periodScore = { recent: 100, career_wide: 80, earlier: 20 } as const;

function editorialScore(candidate: CandidateRecord, role: NarrativeRole, topics: TopicId[], preferred: string[]) {
  const metadata = candidateEditorialMetadata[candidate.candidate_id];
  if (!metadata?.narrativeRoles.includes(role)) return Number.NEGATIVE_INFINITY;
  const preferredIndex = preferred.indexOf(candidate.candidate_id);
  const preference = preferredIndex >= 0 ? 400 - preferredIndex * 5 : 0;
  const topicFit = candidate.proposed_topics.filter((topic) => topics.includes(topic)).length * 200;
  return preference + topicFit + periodScore[metadata.careerPeriod] + salienceScore[metadata.portfolioSalience]
    + strengthScore(candidate.evidence_strength) * 10;
}

function pickForRole(role: NarrativeRole, topics: TopicId[], count: number, used: Set<string>, preferred: string[] = []) {
  const ranked = candidates
    .filter((candidate) => !used.has(candidate.candidate_id))
    .map((candidate) => ({ candidate, score: editorialScore(candidate, role, topics, preferred) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score || a.candidate.candidate_id.localeCompare(b.candidate.candidate_id));
  const selected = ranked.slice(0, count).map(({ candidate }) => candidate);
  selected.forEach((candidate) => used.add(candidate.candidate_id));
  return selected;
}

function recordsFor(ids: string[], used: Set<string>) {
  return ids.map((id) => candidateById.get(id))
    .filter((item): item is CandidateRecord => Boolean(item))
    .filter((item) => !used.has(item.candidate_id));
}

export function assembleEditorialCandidateNarrative(topics: TopicId[]): Narrative {
  const used = new Set<string>();

  const aboutAnchors = recordsFor(["BF-C-073", "BF-C-076"], used);
  aboutAnchors.forEach((candidate) => used.add(candidate.candidate_id));
  const about = [...aboutAnchors, ...pickForRole("about", topics, 1, used, topics.length
    ? topics.flatMap((topic) => PRACTICE_ANCHORS[topic])
    : ["BF-C-043", "BF-C-045", "BF-C-049", "BF-C-074", "BF-C-033"]
  )];

  const recentLeadership = pickForRole("recent_leadership", topics, 4, used, preferredIds(
    PRACTICE_ANCHORS, topics, ["BF-C-043", "BF-C-036", "BF-C-046", "BF-C-049", "BF-C-039"]
  ));
  const proofItems = selectCandidateProofProjects(topics).map(buildCandidateProofItem);

  const recentBridge = recordsFor(["BF-C-075"], used);
  recentBridge.forEach((candidate) => used.add(candidate.candidate_id));
  const throughline = [...recentBridge, ...pickForRole("throughline", topics, 3 - recentBridge.length, used,
    ["BF-C-079", "BF-C-078", "BF-C-077", "BF-C-080"]
  )];

  const sections = [
    {
      id: "system-behind-design", purpose: "proposition" as const, eyebrow: "About Ben",
      headline: "Designing products and the systems behind them",
      ...editorialCopy(about),
      evidenceRefs: about.map((item) => item.candidate_id), disclosure: "inline" as const
    },
    {
      id: "operating-model", purpose: "evidence" as const, eyebrow: "Recent leadership",
      headline: topics.includes("T-004") ? "Making measurement part of the practice" : topics.includes("T-002") ? "Designing the conditions for good design" : "Building design into the organization",
      ...editorialCopy(recentLeadership, "Most recently, that approach took organizational form at Johnson & Johnson."),
      evidenceRefs: recentLeadership.map((item) => item.candidate_id), disclosure: "inline" as const
    },
    {
      id: "institutionalized-capability", purpose: "story" as const, eyebrow: "Career throughline",
      headline: "A pattern across roles and industries",
      ...editorialCopy(throughline, "The recent work extends a longer career pattern.",
        throughline.find((record) => candidateEditorialMetadata[record.candidate_id].careerPeriod === "earlier")),
      evidenceRefs: throughline.map((item) => item.candidate_id), disclosure: "inline" as const
    },
    {
      id: "proof-to-scale", purpose: "transition" as const, eyebrow: "Proof in practice",
      headline: topics.includes("T-004") ? "Measuring the impact of design"
        : topics.includes("T-002") ? "Putting systems thinking into practice"
        : topics.includes("T-001") ? "Design leadership made concrete"
        : topics.includes("T-003") ? "Making complex enterprise products usable"
        : "The operating model in practice",
      summary: "Selected projects connect a specific challenge and response to a documented outcome.",
      detail: "Together, these project-specific examples show how research, design, and measurement moved from a defined challenge to a documented outcome without blending evidence across products.",
      evidenceRefs: [...new Set(proofItems.flatMap(proofItemEvidenceIds))],
      proof_items: proofItems,
      disclosure: "deep-dive" as const
    }
  ];
  const narrative = NarrativeSchema.parse({ sections, mode: "deterministic", grounding: "candidate_validation" });
  if (!validateNarrativeProofProjects(narrative)) throw new Error("Candidate proof project validation failed");
  return narrative;
}

export function assembleCandidateNarrative(topics: TopicId[], mode: CandidatePlannerMode = candidateNarrativePlannerMode()): Narrative {
  return mode === "legacy" ? assembleLegacyCandidateNarrative(topics) : assembleEditorialCandidateNarrative(topics);
}

