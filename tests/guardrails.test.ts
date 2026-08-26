import { afterEach, describe, expect, it } from "vitest";
import { generateNarrative, validateAiNarrative } from "../netlify/functions/generate";
import { assembleNarrative, selectEvidence } from "../src/shared/narrative";

afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe("bounded AI guardrails", () => {
  it("rejects references outside the deterministically selected evidence", () => {
    const candidate = { ...assembleNarrative([]), sections: assembleNarrative([]).sections.map((section, index) => index ? section : { ...section, evidenceRefs: ["E-999"] }) };
    expect(validateAiNarrative(candidate, new Set(selectEvidence([]).map((item) => item.id)))).toBeNull();
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
});
