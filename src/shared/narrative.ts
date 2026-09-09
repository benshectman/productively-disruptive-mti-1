import { contentPacket, evidenceById, publicEvidenceView, type EvidenceRecord } from "../content/content";
import type { Narrative, TopicId } from "./contracts";
import { approvedBenFactIds, assembleApprovedBenFactsNarrative } from "./approved-benfacts";

const BALANCED_IDS = ["E-001", "E-004", "E-006", "E-008", "E-010", "E-013", "E-014", "E-015"];
const PRIORITY: Record<TopicId, string[]> = {
  "T-001": ["E-002", "E-003", "E-006", "E-007", "E-009", "E-013", "E-015"],
  "T-002": ["E-002", "E-004", "E-005", "E-006", "E-007", "E-014", "E-015"],
  "T-003": ["E-001", "E-003", "E-004", "E-006", "E-009", "E-013", "E-014"],
  "T-004": ["E-007", "E-008", "E-013", "E-015"]
};

function scoreEvidence(record: EvidenceRecord, topics: TopicId[]) {
  const overlap = record.topics.filter((topic) => topics.includes(topic)).length;
  const priority = topics.reduce((score, topic) => score + (PRIORITY[topic].includes(record.id) ? 2 : 0), 0);
  return overlap * 10 + priority - Number(record.id.slice(2)) / 1000;
}

export function selectEvidence(topics: TopicId[], limit = 10): EvidenceRecord[] {
  if (topics.length === 0) return BALANCED_IDS.slice(0, limit).map((id) => evidenceById.get(id)!).filter(Boolean);
  return [...contentPacket.evidence]
    .filter((record) => record.approval_status === "approved" && record.topics.some((topic) => topics.includes(topic)))
    .sort((a, b) => scoreEvidence(b, topics) - scoreEvidence(a, topics))
    .slice(0, limit);
}

export function assembleNarrative(topics: TopicId[]): Narrative {
  return assembleApprovedBenFactsNarrative(topics);
}

export function buildDeepDiveNarrative() {
  return contentPacket.stories[0].beats.map((beat) => ({
    id: beat.id, label: beat.label, period: beat.period, summary: beat.summary, evidenceRefs: beat.evidence,
    evidence: beat.evidence.map((id) => publicEvidenceView(evidenceById.get(id)!))
  }));
}

export function validateNarrativeEvidence(narrative: Narrative, allowedIds?: Set<string>) {
  const ids = allowedIds || approvedBenFactIds;
  return narrative.sections.every((section) => section.evidenceRefs.every((id) => ids.has(id)));
}
export const deterministicFallback = assembleNarrative;

