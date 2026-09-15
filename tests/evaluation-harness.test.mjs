import { describe, expect, it } from "vitest";

import {
  aggregateQualitative,
  aggregateReliability,
  captureGeneration,
  createBlindPairs,
  evaluatorRequest,
  sanityAssessment,
  unblindJudgment,
  validateConfig
} from "../scripts/evaluation/core.mjs";
import { buildMarkdownReport } from "../scripts/evaluation/report.mjs";
import { evaluatePair } from "../scripts/evaluation/evaluator.mjs";

const sections = ["system-behind-design", "operating-model", "proof-to-scale", "institutionalized-capability"];

function responseBody(label = "Example") {
  return {
    requestId: `${label}-request`,
    narrative: {
      mode: "ai",
      grounding: "approved",
      sections: sections.map((id, index) => ({
        id,
        purpose: "evidence",
        eyebrow: `Section ${index + 1}`,
        headline: `${label} headline ${index + 1}`,
        summary: `${label} summary ${index + 1}`,
        detail: `${label} detail ${index + 1}`,
        evidenceRefs: ["BF-C-001"],
        disclosure: "inline"
      }))
    },
    evidence: [{ id: "BF-C-001", claim: "Approved evidence", attribution: "leadership", topics: ["T-001"] }],
    generation: {
      status: "ai",
      generatedFields: 12,
      fallbackFields: 0,
      totalFields: 12,
      aiSections: 4,
      mixedSections: 0,
      fallbackSections: 0,
      totalSections: 4,
      sections: sections.map((id) => ({ id, status: "ai", fields: { headline: "ai", summary: "ai", detail: "ai" } }))
    }
  };
}

function run(environment, configuration, repetition, overrides = {}) {
  return {
    runId: `${environment}-${configuration}-${repetition}`,
    environment,
    environmentId: environment === "control" ? "develop" : "feature/example",
    topicConfigurationId: configuration,
    topicConfigurationLabel: configuration,
    selectedTopicIds: configuration === "none" ? [] : ["T-001"],
    repetition,
    ok: true,
    durationMs: environment === "control" ? 100 : 120,
    diagnostics: responseBody().generation,
    totalFallbackFields: 0,
    fallbackSectionCount: 0,
    fieldProvenance: [],
    generationStatus: "ai",
    validationStatus: null,
    prose: { sections: [{ id: "one", headline: `${environment} headline`, summary: "summary", detail: "detail", proofItems: [] }] },
    evidence: responseBody().evidence,
    rawResponse: responseBody(environment),
    ...overrides
  };
}

function judgment(overall = "B_stronger") {
  const criteria = Object.fromEntries([
    "topicRelevance", "selectivity", "synthesis", "coherence", "nonRepetition", "specificity", "groundedness", "attributionDiscipline", "readability", "evidenceEconomy"
  ].map((criterion) => [criterion, { judgment: overall, rationale: `${criterion} rationale` }]));
  return { criteria, overall: { judgment: overall, rationale: "Overall rationale" }, concerns: [], confidence: "moderate" };
}

describe("evaluation harness", () => {
  it("validates a configurable topic matrix", () => {
    expect(validateConfig({ version: 1, repetitions: 3, topicConfigurations: [{ id: "none", topics: [] }, { id: "one", topics: ["T-001"] }] }).repetitions).toBe(3);
    expect(() => validateConfig({ version: 1, repetitions: 0, topicConfigurations: [] })).toThrow();
  });

  it("captures headers, diagnostics, provenance, prose, evidence, and the raw response", async () => {
    const body = responseBody("Captured");
    const captured = await captureGeneration({
      environment: { name: "control", id: "develop", endpoint: "https://example.test/.netlify/functions/generate" },
      topicConfiguration: { id: "leadership", label: "Leadership", topics: ["T-001"] },
      repetition: 2,
      fetcher: async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { "X-Portfolio-Generation-Status": "ai", "X-Portfolio-Validation-Status": "schema" }
      })
    });
    expect(captured).toMatchObject({ environment: "control", environmentId: "develop", requestId: "Captured-request", generationStatus: "ai", validationStatus: "schema", totalGeneratedFields: 12, totalFallbackFields: 0 });
    expect(captured.fieldProvenance).toHaveLength(12);
    expect(captured.prose.sections[0].headline).toBe("Captured headline 1");
    expect(captured.rawResponse).toEqual(body);
  });

  it("aggregates fallback rates, patterns, validation failures, and latency", () => {
    const fallbackDiagnostics = structuredClone(responseBody().generation);
    fallbackDiagnostics.status = "mixed";
    fallbackDiagnostics.generatedFields = 11;
    fallbackDiagnostics.fallbackFields = 1;
    fallbackDiagnostics.aiSections = 3;
    fallbackDiagnostics.mixedSections = 1;
    fallbackDiagnostics.sections[0].status = "mixed";
    fallbackDiagnostics.sections[0].fields.headline = "fallback";
    const runs = [
      run("control", "none", 1),
      run("treatment", "none", 1, { diagnostics: fallbackDiagnostics, totalFallbackFields: 1, fieldProvenance: [{ sectionId: sections[0], field: "headline", provenance: "fallback" }] })
    ];
    const result = aggregateReliability(runs, { minimumAdditionalFallbackFields: 1, minimumFallbackRateIncrease: 0.01 });
    expect(result.byEnvironment.control.fullyGeneratedRuns).toBe(1);
    expect(result.byEnvironment.treatment.fallbackBySection[`${sections[0]}.headline`]).toBe(1);
    expect(result.comparison.materialRegression).toBe(true);
  });

  it("creates deterministic, balanced blind pairs without exposing environment labels to the evaluator", () => {
    const runs = [];
    for (let index = 0; index < 11; index += 1) {
      runs.push(run("control", `config-${index}`, 1), run("treatment", `config-${index}`, 1));
    }
    const first = createBlindPairs(runs, "stable-seed");
    const second = createBlindPairs(runs, "stable-seed");
    expect(first).toEqual(second);
    const controlAsA = first.filter((pair) => pair.mapping.A === "control").length;
    expect(Math.abs(controlAsA - (first.length - controlAsA))).toBeLessThanOrEqual(1);
    const request = evaluatorRequest(first[0], new Map(runs.map((item) => [item.runId, item])));
    expect(JSON.stringify(request)).not.toContain("develop");
    expect(JSON.stringify(request)).not.toContain("feature/example");
  });

  it("unblinds comparative judgments and audits A/B position bias", () => {
    const pair = createBlindPairs([run("control", "none", 1), run("treatment", "none", 1)], "seed")[0];
    const raw = judgment("A_stronger");
    const unblinded = unblindJudgment(raw, pair);
    const evaluation = { pair, judgment: raw, unblinded };
    const qualitative = aggregateQualitative([evaluation]);
    expect(["control", "treatment"]).toContain(unblinded.overall.environmentResult);
    expect(sanityAssessment(qualitative, [pair]).obviousPositionBias).toBe(false);
    expect(sanityAssessment(null, [pair])).toMatchObject({ qualitativeEvaluationCompleted: false, mappingIsReasonablyBalanced: true, obviousPositionBias: null });
  });

  it("flags a statistically unusual blind-position split even with seven decisive comparisons", () => {
    const qualitative = {
      blindPosition: {
        controlAsA: 17,
        controlAsB: 16,
        aOverallWins: 0,
        bOverallWins: 7
      }
    };
    expect(sanityAssessment(qualitative)).toMatchObject({
      obviousPositionBias: true,
      decisiveComparisons: 7,
      largerBlindSideShare: 1,
      positionBiasPValue: 0.015625
    });
  });

  it("performs one structured evaluator pass and preserves its raw response", async () => {
    const runs = [run("control", "none", 1), run("treatment", "none", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    let calls = 0;
    const raw = judgment("B_stronger");
    const result = await evaluatePair({
      pair,
      runsById: new Map(runs.map((item) => [item.runId, item])),
      apiKey: "test-key",
      model: "test-model",
      fetcher: async (_url, init) => {
        calls += 1;
        expect(init.headers.Authorization).toBe("Bearer test-key");
        return new Response(JSON.stringify({ output_text: JSON.stringify(raw), id: "evaluation-response" }), { status: 200 });
      }
    });
    expect(calls).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.rawEvaluatorResponse.id).toBe("evaluation-response");
    expect(["control", "treatment"]).toContain(result.unblinded.overall.environmentResult);
  });

  it("renders reliability, qualitative evidence, and complete shortlisted prose", () => {
    const runs = [run("control", "none", 1), run("treatment", "none", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    const raw = judgment("equivalent");
    const evaluation = { pair, judgment: raw, unblinded: unblindJudgment(raw, pair), shortlistReasons: ["no meaningful difference"] };
    const reliability = aggregateReliability(runs);
    const qualitative = aggregateQualitative([evaluation]);
    const report = buildMarkdownReport({
      metadata: { generatedAt: "2026-09-15T00:00:00Z", environments: { control: { id: "develop" }, treatment: { id: "feature/example" } }, topicConfigurationCount: 1, repetitions: 1 },
      reliability,
      qualitative,
      shortlist: [evaluation],
      runs,
      sanity: null
    });
    expect(report).toContain("## Reliability summary");
    expect(report).toContain("## Cases Ben should review");
    expect(report).toContain("control headline");
    expect(report).toContain("treatment headline");
  });
});
