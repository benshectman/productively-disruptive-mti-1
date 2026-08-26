import packetJson from "./mti-1-content-packet.json";
import type { TopicId } from "../shared/contracts";

export type Attribution = "personal" | "leadership" | "team" | "organization" | "shared_leadership";
export type EvidenceRecord = {
  id: string;
  claim: string;
  attribution: Attribution;
  topics: TopicId[];
  supports: string[];
  sources: string[];
  approval_status: "approved";
};
export type ContentPacket = Omit<typeof packetJson, "evidence"> & { evidence: EvidenceRecord[] };

export const contentPacket = packetJson as ContentPacket;
export const evidenceById = new Map(contentPacket.evidence.map((item) => [item.id, item]));
export const sourceById = new Map(contentPacket.sources.map((item) => [item.id, item]));

export function validateContentReferences(packet: ContentPacket = contentPacket): string[] {
  const errors: string[] = [];
  const evidenceIds = new Set(packet.evidence.map((item) => item.id));
  const sourceIds = new Set(packet.sources.map((item) => item.id));
  const topicIds = new Set(packet.topics.map((item) => item.id));
  const propositionIds = new Set(packet.propositions.map((item) => item.id));
  for (const evidence of packet.evidence) {
    for (const topic of evidence.topics) if (!topicIds.has(topic)) errors.push(`${evidence.id} references missing topic ${topic}`);
    for (const source of evidence.sources) if (!sourceIds.has(source)) errors.push(`${evidence.id} references missing source ${source}`);
    for (const proposition of evidence.supports) if (!propositionIds.has(proposition)) errors.push(`${evidence.id} references missing proposition ${proposition}`);
  }
  for (const story of packet.stories) for (const beat of story.beats) {
    for (const evidence of beat.evidence) if (!evidenceIds.has(evidence)) errors.push(`${beat.id} references missing evidence ${evidence}`);
  }
  for (const source of packet.sources) {
    if (!(["shareable", "knowledge_only"] as string[]).includes(source.visibility)) errors.push(`${source.id} has invalid visibility`);
  }
  return errors;
}

export function publicEvidenceView(record: EvidenceRecord) {
  return { id: record.id, claim: record.claim, attribution: record.attribution, topics: record.topics };
}
