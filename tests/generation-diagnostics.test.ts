import { afterEach, describe, expect, it } from "vitest";

import { applyAiFraming, generateNarrativeWithStatus } from "../netlify/functions/generate";
import { assembleNarrative } from "../src/shared/narrative";
import type { GenerationDiagnostics } from "../src/shared/contracts";

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
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
});
