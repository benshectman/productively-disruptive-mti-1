import { evidenceById, publicEvidenceView } from "../content/content";
import type { GroundingMode, PublicEvidence } from "./contracts";

export type EvidencePresentation = {
  contextLabel: string;
  items: PublicEvidence[];
  grounding: GroundingMode;
};

export const approvedEvidenceCatalog = [...evidenceById.values()].map(publicEvidenceView);

export function buildEvidencePresentation(evidenceRefs: string[], contextLabel: string, catalog: PublicEvidence[] = approvedEvidenceCatalog): EvidencePresentation {
  const records = new Map(catalog.map((record) => [record.id, record]));
  const seen = new Set<string>();
  const items = evidenceRefs.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const record = records.get(id);
    return record ? [record] : [];
  });
  return { contextLabel, items, grounding: evidenceRefs.some((id) => id.startsWith("BF-C-")) ? "candidate_validation" : "approved" };
}

export function approvedPointsLabel(count: number): string {
  return `${count} approved ${count === 1 ? "point" : "points"}`;
}

export function evidencePointsLabel(count: number, grounding: GroundingMode): string {
  if (grounding === "candidate_validation") return `${count} unapproved validation ${count === 1 ? "point" : "points"}`;
  return approvedPointsLabel(count);
}
