import type { GenerationDiagnostics, GenerationFieldProvenance, GenerationSectionDiagnostics, Narrative } from "./contracts";

type SectionFields = GenerationSectionDiagnostics["fields"];

export function summarizeGenerationDiagnostics(sections: Array<{ id: string; fields: SectionFields }>): GenerationDiagnostics {
  const sectionDiagnostics = sections.map(({ id, fields }) => {
    const generated = Object.values(fields).filter((value) => value === "ai").length;
    return { id, fields, status: generated === 3 ? "ai" : generated === 0 ? "fallback" : "mixed" } satisfies GenerationSectionDiagnostics;
  });
  const generatedFields = sectionDiagnostics.reduce((count, section) =>
    count + Object.values(section.fields).filter((value) => value === "ai").length, 0);
  const fallbackFields = 12 - generatedFields;
  const aiSections = sectionDiagnostics.filter((section) => section.status === "ai").length;
  const mixedSections = sectionDiagnostics.filter((section) => section.status === "mixed").length;
  const fallbackSections = sectionDiagnostics.filter((section) => section.status === "fallback").length;
  return {
    status: generatedFields === 12 ? "ai" : generatedFields === 0 ? "fallback" : "mixed",
    generatedFields,
    fallbackFields,
    totalFields: 12,
    aiSections,
    mixedSections,
    fallbackSections,
    totalSections: 4,
    sections: sectionDiagnostics
  };
}

export function deterministicGenerationDiagnostics(narrative: Pick<Narrative, "sections">): GenerationDiagnostics {
  const fallback: GenerationFieldProvenance = "fallback";
  return summarizeGenerationDiagnostics(narrative.sections.map((section) => ({
    id: section.id,
    fields: { headline: fallback, summary: fallback, detail: fallback }
  })));
}
