import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  aggregateQualitative,
  aggregateReliability,
  arbitrationRequest,
  captureGeneration,
  classifyPairEligibility,
  compareIndependentAssessments,
  createBlindPairs,
  deterministicUnblindedOutcome,
  independentAssessmentRequest,
  mirrorPair,
  reconcileMirroredArbitrations,
  sanityAssessment,
  validateConfig
} from "../scripts/evaluation/core.mjs";
import { buildMarkdownReport } from "../scripts/evaluation/report.mjs";
import { evaluatePair, preflightEvaluator } from "../scripts/evaluation/evaluator.mjs";
import { args, evaluateBundle, needsQualitativeEvaluation, writeJsonAtomic } from "../scripts/evaluation/run.mjs";

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
      rejections: [],
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

const criteriaNames = ["topicRelevance", "selectivity", "synthesis", "coherence", "nonRepetition", "specificity", "groundedness", "attributionDiscipline", "readability", "evidenceEconomy"];

function assessment(rating = "adequate", overrides = {}) {
  const criteria = Object.fromEntries(criteriaNames.map((criterion) => [criterion, { rating, rationale: `${criterion} rationale` }]));
  for (const [criterion, value] of Object.entries(overrides.criteria || {})) criteria[criterion] = { rating: value, rationale: `${criterion} override` };
  return { criteria, overall: { rating: overrides.overall || rating, rationale: "Overall rationale" }, concerns: overrides.concerns || [], confidence: overrides.confidence || "moderate" };
}

function completedEvaluation(pair, control = assessment(), treatment = assessment()) {
  const deterministicComparison = compareIndependentAssessments(control, treatment);
  const unblinded = deterministicUnblindedOutcome(deterministicComparison, control, treatment);
  return {
    pair,
    independentAssessments: { control: { assessment: control }, treatment: { assessment: treatment } },
    deterministicComparison,
    arbitrationRequired: false,
    unblinded,
    judgment: { confidence: deterministicComparison.confidence },
    final: { classification: deterministicComparison.classification, confidence: deterministicComparison.confidence, criteria: unblinded.criteria }
  };
}

function arbitrationPass(pair, judgment, confidence = "moderate") {
  const criteria = Object.fromEntries(criteriaNames.map((criterion) => [criterion, { judgment, rationale: `${criterion} rationale` }]));
  const raw = { criteria, overall: { judgment, rationale: "Arbitration rationale" }, concerns: [], confidence };
  const translate = (value) => value === "A_stronger" ? pair.mapping.A : value === "B_stronger" ? pair.mapping.B : value;
  const unblinded = {
    ...raw,
    criteria: Object.fromEntries(criteriaNames.map((criterion) => [criterion, { ...criteria[criterion], environmentResult: translate(judgment) }])),
    overall: { ...raw.overall, environmentResult: translate(judgment) },
    concerns: []
  };
  return { pair, durationMs: 1, judgment: raw, unblinded, evaluatorModel: "test", startedAt: "now" };
}

describe("evaluation harness", () => {
  it("validates a configurable topic matrix", () => {
    expect(validateConfig({ version: 1, repetitions: 3, topicConfigurations: [{ id: "none", topics: [] }, { id: "one", topics: ["T-001"] }] }).repetitions).toBe(3);
    expect(() => validateConfig({ version: 1, repetitions: 0, topicConfigurations: [] })).toThrow();
  });

  it("captures headers, diagnostics, provenance, prose, evidence, and the raw response", async () => {
    const body = responseBody("Captured");
    body.generation.rejections = [{
      sectionId: sections[0],
      field: "headline",
      category: "headline-acronym",
      reason: "Acronym expansion is not present in the lead.",
      candidate: "Building the XDMO model",
      context: { rejectedAcronyms: ["XDMO"] }
    }];
    let requestedUrl;
    const captured = await captureGeneration({
      environment: { name: "control", id: "develop", endpoint: "https://example.test/.netlify/functions/generate" },
      topicConfiguration: { id: "leadership", label: "Leadership", topics: ["T-001"] },
      repetition: 2,
      fetcher: async (url) => {
        requestedUrl = new URL(url);
        return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "X-Portfolio-Generation-Status": "ai", "X-Portfolio-Validation-Status": "schema" }
        });
      }
    });
    expect(requestedUrl.searchParams.get("diagnostics")).toBe("1");
    expect(captured).toMatchObject({ environment: "control", environmentId: "develop", requestId: "Captured-request", generationStatus: "ai", validationStatus: "schema", totalGeneratedFields: 12, totalFallbackFields: 0, rejectionDiagnosticsAvailable: true, rejectionCount: 1 });
    expect(captured.fieldProvenance).toHaveLength(12);
    expect(captured.prose.sections[0].headline).toBe("Captured headline 1");
    expect(captured.diagnostics.rejections[0]).toMatchObject({ category: "headline-acronym", candidate: "Building the XDMO model" });
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
    fallbackDiagnostics.rejections = [
      { sectionId: sections[0], field: "headline", category: "headline-too-long", reason: "Too long", candidate: "A long headline" },
      { sectionId: sections[0], field: "headline", category: "headline-word-count", reason: "Too many words", candidate: "A long headline" }
    ];
    const controlDiagnostics = structuredClone(responseBody().generation);
    delete controlDiagnostics.rejections;
    const runs = [
      run("control", "none", 1, { diagnostics: controlDiagnostics }),
      run("treatment", "none", 1, { diagnostics: fallbackDiagnostics, totalFallbackFields: 1, fieldProvenance: [{ sectionId: sections[0], field: "headline", provenance: "fallback" }] })
    ];
    const result = aggregateReliability(runs, { minimumAdditionalFallbackFields: 1, minimumFallbackRateIncrease: 0.01 });
    expect(result.byEnvironment.control.fullyGeneratedRuns).toBe(1);
    expect(result.byEnvironment.control.rejectionDiagnosticsAvailableRuns).toBe(0);
    expect(result.byEnvironment.treatment.fallbackBySection[`${sections[0]}.headline`]).toBe(1);
    expect(result.byEnvironment.treatment).toMatchObject({
      rejectionDiagnosticsAvailableRuns: 1,
      rejectionCount: 2,
      runsWithRejections: 1,
      rejectionsByCategory: { "headline-too-long": 1, "headline-word-count": 1 },
      rejectionsBySection: { [sections[0]]: 2 },
      rejectionsByField: { headline: 2 }
    });
    expect(result.comparison.materialRegression).toBe(true);
  });

  it("creates deterministic, balanced arbitration placement while keeping independent prompts unlabeled", () => {
    const runs = [];
    for (let index = 0; index < 11; index += 1) {
      runs.push(run("control", `config-${index}`, 1), run("treatment", `config-${index}`, 1));
    }
    const first = createBlindPairs(runs, "stable-seed");
    const second = createBlindPairs(runs, "stable-seed");
    expect(first).toEqual(second);
    const controlAsA = first.filter((pair) => pair.mapping.A === "control").length;
    expect(Math.abs(controlAsA - (first.length - controlAsA))).toBeLessThanOrEqual(1);
    const request = independentAssessmentRequest(runs[0], first[0]);
    expect(JSON.stringify(request)).not.toContain("develop");
    expect(JSON.stringify(request)).not.toContain("feature/example");
    expect(JSON.stringify(request)).not.toContain("responseA");
    expect(JSON.stringify(request)).not.toContain("responseB");
    expect(arbitrationRequest(first[0], new Map(runs.map((item) => [item.runId, item])))).toHaveProperty("responseA");
  });

  it("classifies identical structured assessments as equivalent", () => {
    expect(compareIndependentAssessments(assessment(), assessment())).toMatchObject({ classification: "equivalent" });
  });

  it("classifies a clearly stronger control assessment", () => {
    expect(compareIndependentAssessments(assessment("strong"), assessment("adequate"))).toMatchObject({ classification: "control_stronger" });
  });

  it("classifies a clearly stronger treatment assessment", () => {
    expect(compareIndependentAssessments(assessment("adequate"), assessment("strong"))).toMatchObject({ classification: "treatment_stronger" });
  });

  it("leaves mixed criterion signals unresolved", () => {
    const control = assessment("adequate", { criteria: { synthesis: "strong" } });
    const treatment = assessment("adequate", { criteria: { readability: "strong" } });
    expect(compareIndependentAssessments(control, treatment)).toMatchObject({ classification: "unresolved", criteriaConflict: true });
  });

  it("treats one isolated criterion difference as effectively equivalent", () => {
    const control = assessment("adequate", { criteria: { synthesis: "strong" } });
    expect(compareIndependentAssessments(control, assessment("adequate"))).toMatchObject({ classification: "equivalent", minimumCriterionLead: 3 });
  });

  it("excludes generated-vs-fallback and fallback-vs-fallback from prose comparison", () => {
    const generated = run("control", "none", 1);
    const fallback = run("treatment", "none", 1, { totalFallbackFields: 1 });
    expect(classifyPairEligibility(generated, fallback)).toMatchObject({ qualitativeEligible: false, kind: "generated-vs-fallback" });
    expect(classifyPairEligibility({ ...generated, totalFallbackFields: 1 }, fallback)).toMatchObject({ qualitativeEligible: false, kind: "fallback-vs-fallback" });
  });

  it("maps arbitration A/B results back to the environment", () => {
    const pair = createBlindPairs([run("control", "none", 1), run("treatment", "none", 1)], "seed")[0];
    expect(arbitrationPass(pair, "A_stronger").unblinded.overall.environmentResult).toBe(pair.mapping.A);
    expect(arbitrationPass(pair, "B_stronger").unblinded.overall.environmentResult).toBe(pair.mapping.B);
  });

  it("retains position metadata and accepts mirrored agreement on the underlying response", () => {
    const pair = createBlindPairs([run("control", "none", 1), run("treatment", "none", 1)], "seed")[0];
    const mirrored = mirrorPair(pair);
    const originalJudgment = pair.mapping.A === "control" ? "A_stronger" : "B_stronger";
    const mirroredJudgment = mirrored.mapping.A === "control" ? "A_stronger" : "B_stronger";
    const result = reconcileMirroredArbitrations(arbitrationPass(pair, originalJudgment), arbitrationPass(mirrored, mirroredJudgment));
    expect(result.mirrorAudit).toMatchObject({ positionSensitive: false, originalOverall: "control", mirroredOverall: "control" });
    expect(result.evaluatorPasses.original.pair.mapping).toEqual(pair.mapping);
  });

  it("marks mirrored position-following arbitration unstable and unresolved", () => {
    const pair = createBlindPairs([run("control", "none", 1), run("treatment", "none", 1)], "seed")[0];
    const result = reconcileMirroredArbitrations(arbitrationPass(pair, "B_stronger"), arbitrationPass(mirrorPair(pair), "B_stronger"));
    expect(result.mirrorAudit.positionSensitive).toBe(true);
    expect(result.unblinded.overall.environmentResult).toBe("unresolved");
    expect(result.judgment.confidence).toBe("low");
  });

  it("performs two isolated assessments without A/B framing when they resolve deterministically", async () => {
    const runs = [run("control", "none", 1), run("treatment", "none", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    let calls = 0;
    const result = await evaluatePair({
      pair,
      runsById: new Map(runs.map((item) => [item.runId, item])),
      apiKey: "test-key",
      model: "test-model",
      fetcher: async (_url, init) => {
        calls += 1;
        expect(init.headers.Authorization).toBe("Bearer test-key");
        const body = JSON.parse(init.body);
        expect(body.instructions).toContain("There is no competing response");
        expect(body.input).not.toContain("responseA");
        return new Response(JSON.stringify({ output_text: JSON.stringify(assessment()), id: `assessment-${calls}` }), { status: 200 });
      }
    });
    expect(calls).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.final.classification).toBe("equivalent");
    expect(result.arbitrationRequired).toBe(false);
    expect(result.final.confidence).toBe("moderate");
  });

  it("uses blinded arbitration only after conflicting independent assessments", async () => {
    const runs = [run("control", "none", 1), run("treatment", "none", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    const responses = [
      assessment("adequate", { criteria: { synthesis: "strong" } }),
      assessment("adequate", { criteria: { readability: "strong" } }),
      arbitrationPass(pair, "B_stronger").judgment,
      arbitrationPass(mirrorPair(pair), "B_stronger").judgment
    ];
    let calls = 0;
    const result = await evaluatePair({
      pair,
      runsById: new Map(runs.map((item) => [item.runId, item])),
      apiKey: "test-key",
      model: "test-model",
      fetcher: async () => new Response(JSON.stringify({ output_text: JSON.stringify(responses[calls++]) }), { status: 200 })
    });
    expect(calls).toBe(3);
    expect(result.arbitrationRequired).toBe(true);
    expect(result.arbitration).toBeTruthy();
    expect(result.arbitrationMirror).toBeNull();
  });

  it("does not call the evaluator for a fallback-containing pair", async () => {
    const runs = [run("control", "none", 1), run("treatment", "none", 1, { totalFallbackFields: 1 })];
    const pair = createBlindPairs(runs, "seed")[0];
    let calls = 0;
    const result = await evaluatePair({
      pair,
      runsById: new Map(runs.map((item) => [item.runId, item])),
      apiKey: "test-key",
      model: "test-model",
      fetcher: async () => { calls += 1; return new Response(); }
    });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ qualitativeEligible: false, finalPairClassification: "excluded" });
    expect(result.exclusionReason).toContain("reliability event");
  });

  it("preflights evaluator access without sending portfolio or evidence data", async () => {
    let requestBody;
    const result = await preflightEvaluator({
      apiKey: "test-key",
      model: "test-model",
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ output_text: "EVALUATOR_PREFLIGHT_OK" }), { status: 200 });
      }
    });
    expect(requestBody).toMatchObject({ model: "test-model", store: false });
    expect(JSON.stringify(requestBody)).not.toContain("Approved evidence");
    expect(result.evaluatorModel).toBe("test-model");
  });

  it("supports explicit staged evaluation and atomically persists checkpoints", async () => {
    expect(args(["--evaluate-existing", "capture.json", "--output", "reports"])).toMatchObject({ input: "capture.json", output: "reports" });
    const directory = await mkdtemp(path.join(os.tmpdir(), "portfolio-eval-checkpoint-"));
    const filename = path.join(directory, "capture.json");
    try {
      await writeJsonAtomic(filename, { evaluations: [{ pair: { pairId: "one" } }] });
      expect(JSON.parse(await readFile(filename, "utf8"))).toEqual({ evaluations: [{ pair: { pairId: "one" } }] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes evaluator progress pair by pair without repeating completed comparisons", async () => {
    const runs = [
      run("control", "one", 1), run("treatment", "one", 1),
      run("control", "two", 1), run("treatment", "two", 1)
    ];
    const pairs = createBlindPairs(runs, "seed");
    const completed = completedEvaluation(pairs[0]);
    const bundle = { metadata: { mode: "comparison" }, runs, pairs, evaluations: [completed] };
    const evaluated = [];
    let persisted = 0;
    expect(needsQualitativeEvaluation(bundle, false)).toBe(true);
    await evaluateBundle({
      bundle,
      config: { requestDelayMs: 0 },
      apiKey: "test-key",
      model: "test-model",
      sanityMode: false,
      evaluator: async ({ pair }) => {
        evaluated.push(pair.pairId);
        return completedEvaluation(pair, assessment("adequate"), assessment("strong"));
      },
      persist: async () => { persisted += 1; }
    });
    expect(evaluated).toEqual([pairs[1].pairId]);
    expect(persisted).toBe(1);
    expect(bundle.evaluations).toHaveLength(2);
    expect(needsQualitativeEvaluation(bundle, false)).toBe(false);
  });

  it("renders reliability, qualitative evidence, and complete shortlisted prose", () => {
    const treatmentDiagnostics = structuredClone(responseBody().generation);
    treatmentDiagnostics.rejections = [{ sectionId: sections[0], field: "headline", category: "headline-acronym", reason: "Unexplained acronym", candidate: "Building the XDMO model" }];
    const runs = [run("control", "none", 1), run("treatment", "none", 1, { diagnostics: treatmentDiagnostics })];
    const pair = createBlindPairs(runs, "seed")[0];
    const evaluation = { ...completedEvaluation(pair), shortlistReasons: ["no meaningful difference"] };
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
    expect(report).toContain("## Rejection diagnostics");
    expect(report).toContain("Detailed rejected candidates, reasons, and context remain");
    expect(report).toContain("headline-acronym: 1");
    expect(report).toContain("## Cases Ben should review");
    expect(report).toContain("Independent control assessment");
    expect(report).toContain("Arbitration required: 0");
    expect(report).toContain("control headline");
    expect(report).toContain("treatment headline");
  });

  it("aggregates equivalent, unresolved, arbitration, and position-audit outcomes", () => {
    const runs = [
      run("control", "one", 1), run("treatment", "one", 1),
      run("control", "two", 1), run("treatment", "two", 1)
    ];
    const pairs = createBlindPairs(runs, "seed");
    const equivalent = completedEvaluation(pairs[0]);
    const mixed = completedEvaluation(
      pairs[1],
      assessment("adequate", { criteria: { synthesis: "strong" } }),
      assessment("adequate", { criteria: { readability: "strong" } })
    );
    const original = arbitrationPass(pairs[1], "B_stronger");
    const mirrored = arbitrationPass(mirrorPair(pairs[1]), "B_stronger");
    const reconciled = reconcileMirroredArbitrations(original, mirrored);
    const unresolved = {
      ...mixed,
      arbitrationRequired: true,
      arbitration: original,
      arbitrationMirror: mirrored,
      mirrorAudit: reconciled.mirrorAudit,
      judgment: reconciled.judgment,
      unblinded: reconciled.unblinded,
      final: { classification: "unresolved", confidence: "low", criteria: reconciled.unblinded.criteria }
    };
    const aggregate = aggregateQualitative([equivalent, unresolved]);
    expect(aggregate.overall).toMatchObject({ equivalent: 1, unresolved: 1 });
    expect(aggregate).toMatchObject({ arbitrationRequiredCount: 1, arbitrationInstabilityCount: 1 });
    expect(aggregate.positionBiasAudit).toMatchObject({ arbitrationPassCount: 2, bOverallWins: 2 });
  });
});
