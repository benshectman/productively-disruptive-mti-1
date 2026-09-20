import { afterEach, describe, expect, it } from "vitest";

import { applyAiFraming, generateNarrativeWithStatus } from "../netlify/functions/generate";
import { assembleNarrative } from "../src/shared/narrative";
import type { GenerationDiagnostics, GenerationRejection } from "../src/shared/contracts";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
});

describe("generation diagnostics", () => {
  it("identifies a missing API key without exposing a value", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await generateNarrativeWithStatus(["T-001"]);
    expect(result.status).toBe("missing-api-key");
    expect(result.narrative.mode).toBe("deterministic");
    expect(result.diagnostics).toMatchObject({ status: "fallback", generatedFields: 0, fallbackFields: 12, fallbackSections: 4 });
  });

  it("records only the status code for an upstream rejection", async () => {
    process.env.OPENAI_API_KEY = "test-secret-that-must-not-be-returned";
    const result = await generateNarrativeWithStatus(
      ["T-001"],
      async () => new Response("sensitive upstream body", { status: 401 }),
      "test-request",
    );
    expect(result.status).toBe("upstream-error");
    expect(result.upstreamStatus).toBe(401);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(JSON.stringify(result)).not.toContain("sensitive upstream body");
  });

  function validFraming() {
    return {
      sections: [
        ["system-behind-design", "Designing the System Behind the Work"],
        ["operating-model", "Building Design Into the Organization"],
        ["proof-to-scale", "Turning Practice Into Measurable Progress"],
        ["institutionalized-capability", "Connecting Leadership Across a Career"]
      ].map(([id, headline], index) => ({
        id,
        headline,
        summary: `This generated lead connects the section's central idea to credible professional evidence and gives the reader a clear orientation for part ${String.fromCharCode(65 + index)}.`,
        detail: `This generated detail adds useful context about the work, the operating conditions around it, and the role of design leadership. It remains intentionally qualitative so it introduces no unsupported measurements while still providing enough substance for careful validation in part ${String.fromCharCode(65 + index)}.`
      }))
    };
  }

  function validateWithDiagnostics(value: unknown) {
    let diagnostics: GenerationDiagnostics | undefined;
    const narrative = applyAiFraming(value, assembleNarrative([]), undefined, undefined, undefined, (result) => { diagnostics = result; });
    expect(narrative).not.toBeNull();
    expect(diagnostics).toBeDefined();
    return diagnostics!;
  }

  function validateWithRejections(value: unknown, evidenceTextBySection?: Map<string, string>) {
    const rejections: GenerationRejection[] = [];
    const narrative = applyAiFraming(
      value,
      assembleNarrative([]),
      undefined,
      evidenceTextBySection,
      undefined,
      undefined,
      (rejection) => { rejections.push(rejection); },
    );
    return { narrative, rejections };
  }

  it("records all twelve fields when every generated field passes validation", () => {
    const diagnostics = validateWithDiagnostics(validFraming());
    expect(diagnostics).toMatchObject({ status: "ai", generatedFields: 12, fallbackFields: 0, aiSections: 4, mixedSections: 0, fallbackSections: 0 });
    expect(diagnostics.sections.every((section) => section.status === "ai")).toBe(true);
  });

  it("records field provenance and section status for a mixed result", () => {
    const framing = validFraming();
    framing.sections[0].headline = "XDMO Shapes the Work";
    framing.sections[1].summary = "Too short";
    framing.sections[2].detail = "Too short";
    const diagnostics = validateWithDiagnostics(framing);
    expect(diagnostics).toMatchObject({ status: "mixed", generatedFields: 9, fallbackFields: 3, aiSections: 1, mixedSections: 3, fallbackSections: 0 });
    expect(diagnostics.sections.find((section) => section.id === framing.sections[0].id)?.fields.headline).toBe("fallback");
    expect(diagnostics.sections.find((section) => section.id === framing.sections[1].id)?.fields.summary).toBe("fallback");
    expect(diagnostics.sections.find((section) => section.id === framing.sections[2].id)?.fields.detail).toBe("fallback");
  });

  it.each([
    ["headline only", ["headline"], { generatedFields: 11, fallbackFields: 1, mixedSections: 1, fallbackSections: 0 }],
    ["summary only", ["summary"], { generatedFields: 11, fallbackFields: 1, mixedSections: 1, fallbackSections: 0 }],
    ["detail only", ["detail"], { generatedFields: 11, fallbackFields: 1, mixedSections: 1, fallbackSections: 0 }],
    ["headline and summary", ["headline", "summary"], { generatedFields: 10, fallbackFields: 2, mixedSections: 1, fallbackSections: 0 }],
    ["summary and detail", ["summary", "detail"], { generatedFields: 10, fallbackFields: 2, mixedSections: 1, fallbackSections: 0 }],
    ["all three", ["headline", "summary", "detail"], { generatedFields: 9, fallbackFields: 3, mixedSections: 0, fallbackSections: 1 }]
  ])("localizes %s schema failures", (_label, invalidFields, expected) => {
    const fallback = assembleNarrative([]);
    const framing = validFraming();
    for (const field of invalidFields as Array<"headline" | "summary" | "detail">) framing.sections[0][field] = "Tiny";

    let diagnostics: GenerationDiagnostics | undefined;
    const narrative = applyAiFraming(framing, fallback, undefined, undefined, undefined, (value) => { diagnostics = value; })!;

    for (const field of ["headline", "summary", "detail"] as const) {
      expect(narrative.sections[0][field]).toBe(invalidFields.includes(field) ? fallback.sections[0][field] : framing.sections[0][field]);
    }
    for (const generatedSection of framing.sections.slice(1)) {
      const actual = narrative.sections.find((section) => section.id === generatedSection.id);
      expect(actual).toMatchObject({
        headline: generatedSection.headline,
        summary: generatedSection.summary,
        detail: generatedSection.detail
      });
    }
    expect(diagnostics).toMatchObject({ status: "mixed", ...expected });
  });

  it("falls back all fields when every generated field fails", () => {
    const fallback = assembleNarrative([]);
    const framing = validFraming();
    for (const section of framing.sections) {
      section.headline = "Tiny";
      section.summary = "Tiny";
      section.detail = "Tiny";
    }

    let diagnostics: GenerationDiagnostics | undefined;
    const narrative = applyAiFraming(framing, fallback, undefined, undefined, undefined, (value) => { diagnostics = value; });

    expect(narrative).toEqual({ ...fallback, mode: "ai" });
    expect(diagnostics).toMatchObject({ status: "fallback", generatedFields: 0, fallbackFields: 12, fallbackSections: 4 });
  });

  it("falls back a malformed or missing field while preserving valid siblings", () => {
    const fallback = assembleNarrative([]);
    const framing: { sections: Array<Record<string, unknown>> } = validFraming();
    delete framing.sections[0].detail;
    framing.sections[1].summary = { malformed: true };

    const narrative = applyAiFraming(framing, fallback)!;

    expect(narrative.sections[0].detail).toBe(fallback.sections[0].detail);
    expect(narrative.sections[0].summary).toBe(framing.sections[0].summary);
    expect(narrative.sections[1].summary).toBe(fallback.sections[1].summary);
    expect(narrative.sections[1].detail).toBe(framing.sections[1].detail);
  });

  it("does not add rejection detail when diagnostics are off", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    process.env.OPENAI_MODEL = "test-model";
    const framing = validFraming();
    framing.sections[0].headline = "Tiny";
    const fakeFetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(framing) }), { status: 200 });

    const result = await generateNarrativeWithStatus(["T-001"], fakeFetch as typeof fetch, "diagnostics-off");

    expect(result.status).toBe("ai");
    expect(result.diagnostics).not.toHaveProperty("rejections");
    expect(result.diagnostics).not.toHaveProperty("model");
  });

  it("captures a rejected headline candidate and specific reason when diagnostics are on", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    process.env.OPENAI_MODEL = "test-model";
    const framing = validFraming();
    framing.sections[0].headline = "Tiny";
    const fakeFetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify(framing) }), { status: 200 });

    const result = await generateNarrativeWithStatus(["T-001"], fakeFetch as typeof fetch, "diagnostics-on", true);

    expect(result.diagnostics.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sectionId: "system-behind-design",
        field: "headline",
        category: "headline-too-short",
        candidate: "Tiny",
        reason: expect.stringContaining("minimum is 8")
      })
    ]));
    expect(result.diagnostics.model).toBe("test-model");
  });

  it("captures acronym rejection detail and the lead used for validation", () => {
    const framing = validFraming();
    framing.sections[0].headline = "Building the XDMO operating model";

    const { narrative, rejections } = validateWithRejections(framing);

    expect(narrative).not.toBeNull();
    expect(rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sectionId: "system-behind-design",
        field: "headline",
        category: "headline-acronym",
        candidate: "Building the XDMO operating model",
        context: expect.objectContaining({ rejectedAcronyms: ["XDMO"], leadUsed: framing.sections[0].summary })
      })
    ]));
  });

  it("does not report acronym rejection for universally permitted terms", () => {
    const framing = validFraming();
    framing.sections[0].headline = "Building UX Capability at J&J";

    const { narrative, rejections } = validateWithRejections(framing);

    expect(narrative).not.toBeNull();
    expect(narrative?.sections[0].headline).toBe("Building UX Capability at J&J");
    expect(rejections.filter((rejection) => rejection.category === "headline-acronym")).toEqual([]);
  });

  it("supplies universally permitted acronyms to every generation section", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    let generationInput: { sections: Array<{ allowedAcronyms: string[] }> } | undefined;
    const fallback = assembleNarrative([]);
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.text.format.name === "portfolio_narrative") {
        generationInput = JSON.parse(body.input);
        return new Response(JSON.stringify({ output_text: JSON.stringify({
          sections: fallback.sections.map(({ id, headline, summary, detail }) => ({ id, headline, summary, detail }))
        }) }), { status: 200 });
      }
      return new Response(JSON.stringify({ output_text: "{}" }), { status: 200 });
    };

    await generateNarrativeWithStatus([], fakeFetch as typeof fetch);

    expect(generationInput?.sections).toHaveLength(4);
    for (const section of generationInput?.sections || []) {
      expect(section.allowedAcronyms).toEqual(expect.arrayContaining(["UX", "J&J"]));
    }
  });

  it("captures offending numeric tokens and falls back only the affected field", () => {
    const framing = validFraming();
    framing.sections[0].detail = `${framing.sections[0].detail} The work produced a 99% improvement.`;
    const evidenceBySection = new Map(framing.sections.map((section) => [section.id, "The assigned evidence reports an 85% improvement."]));

    const { narrative, rejections } = validateWithRejections(framing, evidenceBySection);

    expect(narrative).not.toBeNull();
    expect(narrative?.sections[0].summary).toBe(framing.sections[0].summary);
    expect(narrative?.sections[0].detail).toBe(assembleNarrative([]).sections[0].detail);
    expect(narrative?.sections[1].detail).toBe(framing.sections[1].detail);
    expect(rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sectionId: "system-behind-design",
        field: "detail",
        category: "numeric-grounding",
        context: expect.objectContaining({ offendingNumericTokens: ["99%"], unsupportedAggregate: false, fallbackApplied: true })
      })
    ]));
  });

  it("retains broad fallback for a generation-level API failure", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    const result = await generateNarrativeWithStatus([], async () => new Response("failure", { status: 500 }));

    expect(result.status).toBe("upstream-error");
    expect(result.narrative).toEqual(assembleNarrative([]));
    expect(result.diagnostics).toMatchObject({ generatedFields: 0, fallbackFields: 12, fallbackSections: 4 });
  });

  it("does not create false rejection records for successful generated fields", () => {
    const { narrative, rejections } = validateWithRejections(validFraming());

    expect(narrative).not.toBeNull();
    expect(rejections).toEqual([]);
  });
});
