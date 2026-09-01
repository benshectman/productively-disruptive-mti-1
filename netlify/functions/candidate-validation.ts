import candidateManifestJson from "../../src/content/candidates/ben-facts-migration.v0.2.json";
import { NarrativeSchema, type Attribution, type Narrative, type PublicEvidence, type TopicId } from "../../src/shared/contracts";
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
  const projects = pickCandidates(
    preferredIds(PROJECT_ANCHORS, topics, ["BF-C-053", "BF-C-055", "BF-C-057", "BF-C-062", "BF-C-069"]),
    ["project_candidate"], topics, 4, used
  );
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
      id: "proof-to-scale", purpose: "transition" as const, eyebrow: "Proof in practice",
      headline: labels.length ? `${emphasis} in the work` : "Selected work, grounded in outcomes",
      summary: boundedText(projects.slice(0, 2), 900), evidenceRefs: projects.map((item) => item.candidate_id), disclosure: "deep-dive" as const
    },
    {
      id: "institutionalized-capability", purpose: "story" as const, eyebrow: "Career throughline",
      headline: "A throughline across products and organizations",
      summary: boundedText(throughline.slice(0, 2), 900), evidenceRefs: throughline.map((item) => item.candidate_id), disclosure: "none" as const
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
  const proof = pickForRole("proof", topics, 3, used, preferredIds(
    PROJECT_ANCHORS, topics, ["BF-C-053", "BF-C-056", "BF-C-062", "BF-C-069"]
  ));

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
      id: "proof-to-scale", purpose: "transition" as const, eyebrow: "Proof in practice",
      headline: topics.includes("T-004") ? "Measuring the impact of design"
        : topics.includes("T-002") ? "Putting systems thinking into practice"
        : topics.includes("T-001") ? "Design leadership made concrete"
        : topics.includes("T-003") ? "Making complex enterprise products usable"
        : "The operating model in practice",
      ...editorialCopy(proof),
      evidenceRefs: proof.map((item) => item.candidate_id), disclosure: "deep-dive" as const
    },
    {
      id: "institutionalized-capability", purpose: "story" as const, eyebrow: "Career throughline",
      headline: "A pattern across roles and industries",
      ...editorialCopy(throughline, "The recent work extends a longer career pattern.",
        throughline.find((record) => candidateEditorialMetadata[record.candidate_id].careerPeriod === "earlier")),
      evidenceRefs: throughline.map((item) => item.candidate_id), disclosure: "inline" as const
    }
  ];
  return NarrativeSchema.parse({ sections, mode: "deterministic", grounding: "candidate_validation" });
}

export function assembleCandidateNarrative(topics: TopicId[], mode: CandidatePlannerMode = candidateNarrativePlannerMode()): Narrative {
  return mode === "legacy" ? assembleLegacyCandidateNarrative(topics) : assembleEditorialCandidateNarrative(topics);
}
