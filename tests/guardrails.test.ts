import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAiFraming, generateNarrative } from "../netlify/functions/generate";
import { contentPacket } from "../src/content/content";
import { assembleNarrative } from "../src/shared/narrative";

afterEach(() => { delete process.env.OPENAI_API_KEY; delete process.env.BENFACTS_VALIDATION_MODE; });
beforeEach(() => { process.env.BENFACTS_VALIDATION_MODE = "approved"; });

describe("bounded AI guardrails", () => {
  it("merges framing without allowing the model to change structure or evidence", () => {
    const fallback = assembleNarrative(["T-001"]);
    const framing = { sections: fallback.sections.map((section) => ({ id: section.id, headline: `Framed: ${section.headline}`, summary: `Framed: ${section.summary}` })) };
    const result = applyAiFraming(framing, fallback)!;
    expect(result.mode).toBe("ai");
    expect(result.sections.map(({ id, purpose, eyebrow, evidenceRefs, disclosure, detail }) => ({ id, purpose, eyebrow, evidenceRefs, disclosure, detail })))
      .toEqual(fallback.sections.map(({ id, purpose, eyebrow, evidenceRefs, disclosure, detail }) => ({ id, purpose, eyebrow, evidenceRefs, disclosure, detail })));
  });
  it.each([
    { sections: [] },
    { sections: assembleNarrative([]).sections.map((section) => ({ id: section.id, headline: section.headline, summary: section.summary, evidenceRefs: ["E-999"] })) },
    { sections: assembleNarrative([]).sections.map((section, index) => ({ id: index ? section.id : "invented-section", headline: section.headline, summary: section.summary })) }
  ])("rejects framing that changes the bounded contract", (candidate) => {
    expect(applyAiFraming(candidate, assembleNarrative([]))).toBeNull();
  });
  it("falls back when structured model output is invalid", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    const fakeFetch = async () => new Response(JSON.stringify({ output_text: "not-json" }), { status: 200 });
    const result = await generateNarrative(["T-001"], fakeFetch as typeof fetch);
    expect(result).toEqual(assembleNarrative(["T-001"]));
    expect(result.mode).toBe("deterministic");
  });
  it("falls back when OpenAI is unconfigured", async () => {
    expect(await generateNarrative(["T-002"])).toEqual(assembleNarrative(["T-002"]));
  });
  it("sends only section-relevant approved evidence and requests strict structured framing", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    const fallback = assembleNarrative(["T-001", "T-002"]);
    let requestBody: Record<string, unknown> | undefined;
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const framing = { sections: fallback.sections.map((section) => ({ id: section.id, headline: section.headline, summary: section.summary })) };
      return new Response(JSON.stringify({ output_text: JSON.stringify(framing) }), { status: 200 });
    };
    const result = await generateNarrative(["T-001", "T-002"], fakeFetch as typeof fetch);
    expect(result.mode).toBe("ai");
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.text).toMatchObject({ format: { type: "json_schema", strict: true, name: "portfolio_framing" } });
    const input = JSON.parse(String(requestBody?.input));
    const visibleEvidence = input.sections.flatMap((section: { evidence: unknown[] }) => section.evidence);
    const approvedIds = new Set(contentPacket.evidence.map((item) => item.id));
    expect(visibleEvidence.length).toBeGreaterThan(0);
    expect(visibleEvidence.every((item: { id: string }) => approvedIds.has(item.id))).toBe(true);
    expect(JSON.stringify(visibleEvidence)).not.toContain("knowledge_only");
    expect(JSON.stringify(visibleEvidence)).not.toContain('"sources"');
  });
});

