import { evidenceById, publicEvidenceView } from "../content/content";

export type EvidencePresentation = {
  contextLabel: string;
  items: ReturnType<typeof publicEvidenceView>[];
};

export function buildEvidencePresentation(evidenceRefs: string[], contextLabel: string): EvidencePresentation {
  const seen = new Set<string>();
  const items = evidenceRefs.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const record = evidenceById.get(id);
    return record ? [publicEvidenceView(record)] : [];
  });
  return { contextLabel, items };
}

export function approvedPointsLabel(count: number): string {
  return `${count} approved ${count === 1 ? "point" : "points"}`;
}
