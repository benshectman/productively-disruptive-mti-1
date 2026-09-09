import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAiFraming, generateNarrative, GENERATION_TIMEOUT_MS } from "../netlify/functions/generate";
import approvedCorpus from "../src/content/approved/ben-facts.v1.json";
import { assembleNarrative } from "../src/shared/narrative";

afterEach(() => { delete process.env.OPENAI_API_KEY; vi.useRealTimers(); });

describe("bounded AI guardrails", () => {
  it("merges framing without allowing the model to change structure or evidence", () => {
    const fallback = assembleNarrative(["T-001"]);
    const framing = { sections: fallback.sections.map((section) => ({ id: section.id, headline: `Framed: ${section.headline}`, summary: `Generated lead grounded in the assigned evidence for ${section.eyebrow}.`, detail: `Generated narrative detail grounded in the assigned evidence for ${section.eyebrow}, with enough context to satisfy the bounded semantic contract.` })) };
    const result = applyAiFraming(framing, fallback)!;
    expect(result.mode).toBe("ai");
    expect(result.sections.map(({ id, purpose, eyebrow, evidenceRefs, disclosure }) => ({ id, purpose, eyebrow, evidenceRefs, disclosure })))
      .toEqual(fallback.sections.map(({ id, purpose, eyebrow, evidenceRefs, disclosure }) => ({ id, purpose, eyebrow, evidenceRefs, disclosure })));
    expect(result.sections.map((section) => section.summary)).not.toEqual(fallback.sections.map((section) => section.summary));
    expect(result.sections.map((section) => section.detail)).not.toEqual(fallback.sections.map((section) => section.detail));
  });
  it.each([
    { sections: [] },
    { sections: assembleNarrative([]).sections.map((section) => ({ id: section.id, headline: section.headline, evidenceRefs: ["E-999"] })) },
    { sections: assembleNarrative([]).sections.map((section, index) => ({ id: index ? section.id : "invented-section", headline: section.headline })) },
    { sections: assembleNarrative([]).sections.map((section, index) => ({ id: section.id, headline: index ? section.headline : "A 100 percent invented metric" })) },
    { sections: assembleNarrative([]).sections.map((section, index) => ({ id: section.id, headline: index ? section.headline : "Design leadership across technology领域" })) },
    { sections: assembleNarrative([]).sections.map((section, index) => ({ id: section.id, headline: index ? section.headline : "Design leadership grounded in" })) }
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
  it("uses the temporary thirty-second diagnostic timeout before falling back", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    vi.useFakeTimers();
    let aborted = false;
    const fakeFetch = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
    const resultPromise = generateNarrative([], fakeFetch as typeof fetch);
    await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect((await resultPromise).mode).toBe("deterministic");
  });
  it("sends only section-relevant approved evidence and requests strict structured framing", async () => {
    process.env.OPENAI_API_KEY = "test-only";
    const fallback = assembleNarrative(["T-001", "T-002"]);
    let requestBody: Record<string, unknown> | undefined;
    const safeHeadlines = ["Designing systems behind excellent product experiences", "Embedding design leadership across the organization", "Making enterprise design impact visible", "Building a durable career throughline"];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody ||= JSON.parse(String(init?.body));
      const framing = { sections: fallback.sections.map((section, index) => ({ id: section.id, headline: safeHeadlines[index], summary: "A generated lead paragraph grounded only in the evidence assigned to this section.", detail: "A fuller generated narrative grounded only in the evidence assigned to this section, connecting its supported facts without changing attribution." })) };
      return new Response(JSON.stringify({ output_text: JSON.stringify(framing) }), { status: 200 });
    };
    const result = await generateNarrative(["T-001", "T-002"], fakeFetch as typeof fetch);
    expect(result.mode).toBe("ai");
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.text).toMatchObject({ format: { type: "json_schema", strict: true, name: "portfolio_narrative" } });
    const input = JSON.parse(String(requestBody?.input));
    const visibleEvidence = input.sections.flatMap((section: { evidence: unknown[] }) => section.evidence);
    const approvedIds = new Set(approvedCorpus.facts.map((item) => item.id));
    expect(visibleEvidence.length).toBeGreaterThan(0);
    expect(visibleEvidence.every((item: { id: string }) => approvedIds.has(item.id))).toBe(true);
    expect(JSON.stringify(visibleEvidence)).not.toContain("knowledge_only");
    expect(JSON.stringify(visibleEvidence)).not.toContain('"sources"');
  });

  it("rejects the known SPR measurement distortion without disabling narrative generation", () => {
    const fallback = assembleNarrative([]);
    const generated = { sections: fallback.sections.map((section) => ({
      id: section.id,
      headline: section.headline,
      summary: "The redesign produced measurable improvements across the experience.",
      detail: "The reported improvements all exceeded 100%, including speed to insight, ease of use, usefulness, and Net Promoter Score."
    })) };
    const evidenceBySection = new Map(fallback.sections.map((section) => [section.id, "A 114% increase in speed to insight, an 85% increase in ease of use, a 122% increase in usefulness, and a 104-point increase in Net Promoter Score."]));
    expect(applyAiFraming(generated, fallback, undefined, evidenceBySection)).toBeNull();
  });

  it("rejects invented numbers in generated prose", () => {
    const fallback = assembleNarrative([]);
    const generated = { sections: fallback.sections.map((section) => ({
      id: section.id,
      headline: section.headline,
      summary: "The evidence supports a connected account of the work and its impact.",
      detail: "The work produced a 99% improvement that does not appear in the assigned evidence."
    })) };
    const evidenceBySection = new Map(fallback.sections.map((section) => [section.id, "The evidence reports an 85% increase in ease of use."]));
    expect(applyAiFraming(generated, fallback, undefined, evidenceBySection)).toBeNull();
  });

  it("accepts individually stated SPR measurements with their correct units", () => {
    const fallback = assembleNarrative([]);
    const generated = { sections: fallback.sections.map((section) => ({
      id: section.id,
      headline: section.headline,
      summary: "The redesign produced distinct, measurable improvements across the experience.",
      detail: "Speed to insight increased 114%, ease of use increased 85%, usefulness increased 122%, and Net Promoter Score increased 104 points."
    })) };
    const evidenceBySection = new Map(fallback.sections.map((section) => [section.id, "A 114% increase in speed to insight, an 85% increase in ease of use, a 122% increase in usefulness, and a 104-point increase in Net Promoter Score."]));
    expect(applyAiFraming(generated, fallback, undefined, evidenceBySection)?.mode).toBe("ai");
  });
});

