import candidateManifestJson from "../../src/content/candidates/ben-facts-migration.v0.2.json";
import { NarrativeSchema, type Attribution, type Narrative, type PublicEvidence, type TopicId } from "../../src/shared/contracts";

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

export function assembleCandidateNarrative(topics: TopicId[]): Narrative {
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
      id: "system-behind-design", purpose: "proposition" as const,
      headline: labels.length ? `A career viewed through ${emphasis}` : "A career spent making complexity workable",
      summary: boundedText(about.slice(0, 2), 900), evidenceRefs: about.map((item) => item.candidate_id), disclosure: "inline" as const,
      detail: boundedText(about, 1600)
    },
    {
      id: "operating-model", purpose: "evidence" as const,
      headline: topics.includes("T-004") ? "Measurement as part of the design system" : topics.includes("T-002") ? "Designing the conditions for good design" : "How the practice takes shape",
      summary: boundedText(practice.slice(0, 2), 900), evidenceRefs: practice.map((item) => item.candidate_id), disclosure: "none" as const
    },
    {
      id: "proof-to-scale", purpose: "transition" as const,
      headline: labels.length ? `${emphasis} in the work` : "Selected work, grounded in outcomes",
      summary: boundedText(projects.slice(0, 2), 900), evidenceRefs: projects.map((item) => item.candidate_id), disclosure: "deep-dive" as const
    },
    {
      id: "institutionalized-capability", purpose: "story" as const,
      headline: "A throughline across products and organizations",
      summary: boundedText(throughline.slice(0, 2), 900), evidenceRefs: throughline.map((item) => item.candidate_id), disclosure: "none" as const
    }
  ];
  return NarrativeSchema.parse({ sections, mode: "deterministic", grounding: "candidate_validation" });
}

