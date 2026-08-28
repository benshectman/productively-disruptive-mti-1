import { contentPacket, evidenceById, publicEvidenceView, type EvidenceRecord } from "../content/content";
import { NarrativeSchema, type Narrative, type NarrativeSection, type TopicId } from "./contracts";

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

function refs(selected: EvidenceRecord[], preferred: string[], count: number) {
  const selectedIds = new Set(selected.map((item) => item.id));
  return [...preferred.filter((id) => selectedIds.has(id)), ...preferred.filter((id) => !selectedIds.has(id))].slice(0, count);
}
function claims(ids: string[]) {
  return ids.map((id) => evidenceById.get(id)?.claim).filter(Boolean).join(" ");
}

export function assembleNarrative(topics: TopicId[]): Narrative {
  const selected = selectEvidence(topics);
  const propositionRefs = refs(selected, ["E-002", "E-004", "E-006", "E-014"], 3);
  const operatingRefs = refs(selected, ["E-003", "E-005", "E-006", "E-007", "E-008"], 4);
  const scaleRefs = refs(selected, ["E-010", "E-011", "E-012"], 3);
  const matureRefs = refs(selected, ["E-013", "E-014", "E-015"], 3);
  const topicLabels = topics.map((id) => contentPacket.topics.find((topic) => topic.id === id)?.label).filter(Boolean);
  const sections: NarrativeSection[] = [
    {
      id: "system-behind-design", purpose: "proposition", eyebrow: "About Ben",
      headline: topics.includes("T-002") ? "Designing the system behind the design" : "Design at more than one level",
      summary: contentPacket.propositions[0].statement, evidenceRefs: propositionRefs, disclosure: "inline",
      detail: claims(propositionRefs)
    },
    {
      id: "operating-model", purpose: "evidence", eyebrow: "Recent leadership",
      headline: topics.includes("T-001") ? "From temporary support to an embedded practice" : "A product-centered operating model",
      summary: claims(operatingRefs.slice(0, 2)), evidenceRefs: operatingRefs, disclosure: "none"
    },
    {
      id: "proof-to-scale", purpose: "transition", eyebrow: "Proof in practice",
      headline: topicLabels.length ? `What ${topicLabels.join(" + ")} looks like at enterprise scale` : "Proving the model, then extending its reach",
      summary: claims(scaleRefs), evidenceRefs: scaleRefs, disclosure: "deep-dive"
    },
    {
      id: "institutionalized-capability", purpose: "story", eyebrow: "Career throughline",
      headline: topics.includes("T-004") ? "Measurement became part of the operating system" : "What the model became",
      summary: claims(matureRefs), evidenceRefs: matureRefs, disclosure: "none"
    }
  ];
  return NarrativeSchema.parse({ sections, mode: "deterministic", grounding: "approved" });
}

export function buildDeepDiveNarrative() {
  return contentPacket.stories[0].beats.map((beat) => ({
    id: beat.id, label: beat.label, period: beat.period, summary: beat.summary, evidenceRefs: beat.evidence,
    evidence: beat.evidence.map((id) => publicEvidenceView(evidenceById.get(id)!))
  }));
}

export function validateNarrativeEvidence(narrative: Narrative, allowedIds?: Set<string>) {
  return narrative.sections.every((section) => section.evidenceRefs.every((id) => allowedIds ? allowedIds.has(id) : evidenceById.has(id)));
}
export const deterministicFallback = assembleNarrative;

