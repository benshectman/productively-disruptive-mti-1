import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assembleEditorialCandidateNarrative, candidateValidationIds } from "../netlify/functions/candidate-validation";
import { applyAiFraming } from "../netlify/functions/generate";
import { assembleNarrative } from "../src/shared/narrative";
import { NarrativeSchema, type TopicId } from "../src/shared/contracts";
import { allowedHeadlineAcronyms, expandPresentationAcronyms, headlineAcronymsAreExplained } from "../src/shared/narrative-presentation";

const topics: TopicId[] = ["T-001", "T-002", "T-003", "T-004"];
const configurations = Array.from({ length: 16 }, (_, mask) => topics.filter((_, index) => mask & (1 << index)));
const wordCount = (text: string) => text.trim().split(/\s+/).length;
const framingFor = (narrative: ReturnType<typeof assembleNarrative>) => ({
  sections: narrative.sections.map(({ id, headline, summary, detail }) => ({ id, headline, summary, detail }))
});

describe("headline, lead, and progressive depth", () => {
  it.each(configurations.map((selection) => [selection]))("keeps the editorial hierarchy bounded for topics %j", (selection) => {
    const narrative = assembleEditorialCandidateNarrative(selection);
    expect(NarrativeSchema.safeParse(narrative).success).toBe(true);
    for (const section of narrative.sections) {
      expect(section.headline.length).toBeLessThanOrEqual(64);
      expect(wordCount(section.headline)).toBeLessThanOrEqual(9);
      expect(wordCount(section.summary)).toBeLessThanOrEqual(75);
      expect(section.summary).not.toContain("…");
      expect(section.detail).toBeTruthy();
      expect(section.detail).not.toContain("…");
      expect(section.detail).not.toContain(section.summary);
      expect(headlineAcronymsAreExplained(section.headline, section.summary)).toBe(true);
    }
    expect(narrative.sections[2].disclosure).toBe("deep-dive");
    expect(narrative.sections[2].detail).toBeTruthy();
  });

  it("also gives the approved fallback a lead and details on every block", () => {
    for (const selection of configurations) {
      for (const section of assembleNarrative(selection).sections) {
        expect(section.headline.length).toBeLessThanOrEqual(64);
        expect(wordCount(section.headline)).toBeLessThanOrEqual(9);
        expect(wordCount(section.summary)).toBeLessThanOrEqual(75);
        expect(section.detail).toBeTruthy();
      }
    }
  });

  it("accepts the concise title style, including supported acronyms and curly apostrophes", () => {
    const narrative = assembleEditorialCandidateNarrative([]);
    const framing = framingFor(narrative);
    framing.sections[1].headline = "Establishing and scaling J&J’s XD organization";
    expect(narrative.sections[1].summary).toContain("Johnson & Johnson");
    expect(narrative.sections[1].summary).toContain("Experience Design");
    const result = applyAiFraming(framing, narrative, candidateValidationIds);
    expect(result?.mode).toBe("ai");
    expect(result?.sections[1].headline).toBe(framing.sections[1].headline);
    expect(result?.sections.map(({ summary, detail }) => ({ summary, detail })))
      .toEqual(narrative.sections.map(({ summary, detail }) => ({ summary, detail })));
  });

  it("replaces a paragraph masquerading as a headline instead of clipping it", () => {
    const narrative = assembleEditorialCandidateNarrative([]);
    const framing = framingFor(narrative);
    framing.sections[1].headline = "He recently spearheaded the establishment and growth of a dedicated Experience Design Management Office within Johnson & Johnson to embed UX";
    const result = applyAiFraming(framing, narrative, candidateValidationIds);
    expect(result?.mode).toBe("ai");
    expect(result?.sections[1].headline).toBe(narrative.sections[1].headline);
    expect(result?.sections[1].summary).toBe(framing.sections[1].summary);
  });

  it("replaces an unexplained headline acronym without discarding safe generated prose", () => {
    const narrative = assembleEditorialCandidateNarrative([]);
    const framing = framingFor(narrative);
    framing.sections[0].headline = "Building the XDMO operating model";
    narrative.sections[0].detail = "Experience Design Management Office";
    const result = applyAiFraming(framing, narrative, candidateValidationIds);
    expect(result?.mode).toBe("ai");
    expect(result?.sections[0].headline).toBe(narrative.sections[0].headline);
    expect(result?.sections[0].summary).toBe(framing.sections[0].summary);
    expect(result?.sections[0].detail).toBe(framing.sections[0].detail);
    expect(headlineAcronymsAreExplained("Building the ABC operating model", "ABC")).toBe(false);
  });

  it("uses supported expansions without guessing internal product meanings", () => {
    expect(expandPresentationAcronyms("J&J invested in XD and UX."))
      .toBe("Johnson & Johnson invested in Experience Design and User Experience.");
    expect(expandPresentationAcronyms("The FIRST product")).toBe("The FIRST product");
    expect(allowedHeadlineAcronyms("Experience Design at Johnson & Johnson")).toEqual(["J&J", "XD"]);
  });

  it("offers accessible inline depth independently of the deep-dive branch", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("{section.detail &&");
    expect(app).toContain('section.disclosure === "deep-dive"');
    expect(app).toContain("aria-expanded={expanded}");
    expect(app).toContain('aria-controls={`${section.id}-detail`}');
    expect(app).toContain('about ${section.headline}');
    expect(app).toContain("section.detail.split");
  });
});

