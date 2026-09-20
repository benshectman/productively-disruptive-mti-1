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
import { buildIndependentAssessmentBody, evaluatePair, preflightEvaluator } from "../scripts/evaluation/evaluator.mjs";
import { buildEvaluatorEvidenceContext } from "../scripts/evaluation/evidence-context.mjs";
import { args, evaluateBundle, needsQualitativeEvaluation, writeJsonAtomic } from "../scripts/evaluation/run.mjs";
import approvedCorpusJson from "../src/content/approved/ben-facts.v1.json";
import { approvedEditorialMetadata } from "../src/shared/approved-editorial-metadata.ts";
import { assembleApprovedBenFactsNarrative } from "../src/shared/approved-benfacts.ts";
import { buildEligibleProjectEvidence, buildEligibleSectionEvidencePools } from "../src/shared/eligible-evidence.ts";

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

function criterionAssessment(criterion, value) {
  if (typeof value === "object") {
    return {
      rating: value.rating,
      exception: value.exception ?? null,
      confidence: value.confidence || "medium",
      rationale: `${criterion} override`
    };
  }
  return { rating: value, exception: null, confidence: "medium", rationale: `${criterion} rationale` };
}

function assessment(rating = 3, overrides = {}) {
  const criteria = Object.fromEntries(criteriaNames.map((criterion) => [criterion, criterionAssessment(criterion, rating)]));
  for (const [criterion, value] of Object.entries(overrides.criteria || {})) criteria[criterion] = criterionAssessment(criterion, value);
  const overallValue = typeof overrides.overall === "object" ? overrides.overall : { rating: overrides.overall || rating };
  return {
    criteria,
    overall: {
      rating: overallValue.rating,
      exception: overallValue.exception ?? null,
      confidence: overallValue.confidence || "medium",
      rationale: "Overall rationale"
    },
    concerns: overrides.concerns || [],
    confidence: overrides.confidence || "medium"
  };
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

describe("evaluator evidence context", () => {
  it("reconstructs the same eligible section and proof-project pools used by generation", () => {
    const selectedTopicIds = ["T-003"];
    const narrative = assembleApprovedBenFactsNarrative(selectedTopicIds);
    const prose = {
      sections: narrative.sections.map((section) => ({
        id: section.id,
        proofItems: (section.proof_items || []).map((item) => ({ projectId: item.project_id }))
      }))
    };
    const context = buildEvaluatorEvidenceContext({
      approvedFacts: approvedCorpusJson.facts,
      editorialMetadata: approvedEditorialMetadata,
      selectedTopicIds,
      prose
    });

    for (const pool of buildEligibleSectionEvidencePools(selectedTopicIds)) {
      expect(context.eligibleEvidenceBySection[pool.sectionId]).toEqual(pool.facts);
    }
    for (const item of narrative.sections.find((section) => section.id === "proof-to-scale").proof_items) {
      expect(context.eligibleEvidenceByProject[item.project_id]).toEqual(buildEligibleProjectEvidence(item.project_id, selectedTopicIds));
    }
  });

  it("limits project pools to projects present in the assessed response", () => {
    const context = buildEvaluatorEvidenceContext({
      approvedFacts: approvedCorpusJson.facts,
      editorialMetadata: approvedEditorialMetadata,
      selectedTopicIds: ["T-003"],
      prose: { sections: [{ proofItems: [{ projectId: "askgs" }] }] }
    });

    expect(Object.keys(context.eligibleEvidenceByProject)).toEqual(["askgs"]);
    expect(context.eligibleEvidenceByProject.askgs.length).toBeGreaterThan(0);
    expect(context.eligibleEvidenceByProject.askgs.every((fact) => fact.project_id === "askgs")).toBe(true);
  });
});

function arbitrationPass(pair, judgment, confidence = "medium") {
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

  it("defines the independent five-point schema and calibration guidance", () => {
    const body = buildIndependentAssessmentBody({}, "test-model");
    const criterion = body.text.format.schema.properties.criteria.properties.topicRelevance;
    expect(criterion.properties.rating).toMatchObject({ type: "integer", enum: [1, 2, 3, 4, 5] });
    expect(criterion.properties.exception.enum).toEqual([null, "concern", "unclear"]);
    expect(criterion.properties.confidence.enum).toEqual(["high", "medium", "low"]);
    expect(body.instructions).toContain("A score of 5 should be uncommon");
    expect(body.instructions).toContain("Most competent portfolio content should fall around 3 or 4");
    expect(body.instructions).toContain("Do not use 5 merely because there are no defects or concerns");
    expect(body.instructions).toContain("Use 4 as the default high rating");
    expect(body.instructions).toContain("A normal competent response may have no 5 ratings");
    expect(body.instructions).toContain("Merely satisfying a criterion is not exceptional");
    expect(body.instructions).toContain("no more than one or two ratings of 5 across the ten criteria");
    expect(body.instructions).toContain("Overall quality should be 5 only when multiple criteria are genuinely exceptional");
    expect(body.instructions).toContain("Do not reward verbosity, fact count, or length by themselves");
  });

  it.each([1, 2, 3, 4, 5])("parses and reports rating %i without using exception states", (rating) => {
    const result = compareIndependentAssessments(assessment(rating), assessment(rating));
    expect(result).toMatchObject({ classification: "equivalent" });
    expect(result.criteria.topicRelevance).toMatchObject({
      controlRating: rating,
      treatmentRating: rating,
      controlException: null,
      treatmentException: null,
      result: "equivalent"
    });
  });

  it("keeps concern separate from numeric ratings", () => {
    const control = assessment(4, { criteria: { groundedness: { rating: 4, exception: "concern" } } });
    const result = compareIndependentAssessments(control, assessment(4));
    expect(result).toMatchObject({ classification: "unresolved", concernCriteriaCount: 1 });
    expect(result.criteria.groundedness).toMatchObject({ controlRating: 4, controlException: "concern", result: "concern" });
    expect(deterministicUnblindedOutcome(result, control, assessment(4)).criteria.groundedness).toMatchObject({
      environmentResult: "unresolved",
      controlException: "concern",
      treatmentException: null
    });
  });

  it("keeps unclear separate from numeric ratings", () => {
    const treatment = assessment(3, { criteria: { specificity: { rating: 3, exception: "unclear" } } });
    const result = compareIndependentAssessments(assessment(3), treatment);
    expect(result).toMatchObject({ classification: "equivalent", unclearCriteriaCount: 1 });
    expect(result.criteria.specificity).toMatchObject({ treatmentRating: 3, treatmentException: "unclear", result: "unresolved" });
  });

  it("classifies a clearly stronger control assessment", () => {
    expect(compareIndependentAssessments(assessment(5), assessment(3))).toMatchObject({ classification: "control_stronger" });
  });

  it("classifies a clearly stronger treatment assessment", () => {
    expect(compareIndependentAssessments(assessment(3), assessment(5))).toMatchObject({ classification: "treatment_stronger" });
  });

  it("leaves mixed criterion signals unresolved", () => {
    const control = assessment(3, { criteria: { synthesis: 4 } });
    const treatment = assessment(3, { criteria: { readability: 4 } });
    expect(compareIndependentAssessments(control, treatment)).toMatchObject({ classification: "unresolved", criteriaConflict: true });
  });

  it("does not let an opposing criterion disappear behind a stronger overall rating", () => {
    const control = assessment(3, { overall: 5, criteria: { synthesis: 2 } });
    const treatment = assessment(3);
    expect(compareIndependentAssessments(control, treatment)).toMatchObject({ classification: "unresolved", criterionOpposesOverall: true });
  });

  it("treats one isolated criterion difference as effectively equivalent", () => {
    const control = assessment(3, { criteria: { synthesis: 4 } });
    expect(compareIndependentAssessments(control, assessment(3))).toMatchObject({ classification: "equivalent", minimumCriterionLead: 3 });
  });

  it("does not force a winner from a trivial one-point overall difference", () => {
    expect(compareIndependentAssessments(assessment(3, { overall: 4 }), assessment(3))).toMatchObject({ classification: "equivalent" });
  });

  it("does not resolve a numeric lead when an assessment is low confidence", () => {
    expect(compareIndependentAssessments(assessment(5, { confidence: "low" }), assessment(3))).toMatchObject({ classification: "unresolved", confidence: "low" });
  });

  it("preserves exception states through comparison and reporting aggregates", () => {
    const runs = [run("control", "none", 1), run("treatment", "none", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    const evaluation = completedEvaluation(
      pair,
      assessment(4, { criteria: { groundedness: { rating: 4, exception: "concern" } } }),
      assessment(4, { criteria: { specificity: { rating: 4, exception: "unclear" } } })
    );
    const aggregate = aggregateQualitative([evaluation]);
    expect(aggregate.exceptionCounts).toMatchObject({ concern: 1, unclear: 1 });
    expect(aggregate.overallRatingDistribution[4]).toBe(2);
    expect(aggregate.overallExceptionCounts).toMatchObject({ concern: 0, unclear: 0 });
    expect(aggregate.criterionExceptionCounts.groundedness.concern).toBe(1);
    expect(aggregate.criterionExceptionCounts.specificity.unclear).toBe(1);
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
    expect(result.final.confidence).toBe("medium");
  });

  it("uses blinded arbitration only after conflicting independent assessments", async () => {
    const runs = [run("control", "none", 1), run("treatment", "none", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    const responses = [
      assessment(3, { criteria: { synthesis: 4 } }),
      assessment(3, { criteria: { readability: 4 } }),
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
        return completedEvaluation(pair, assessment(3), assessment(5));
      },
      persist: async () => { persisted += 1; }
    });
    expect(evaluated).toEqual([pairs[1].pairId]);
    expect(persisted).toBe(1);
    expect(bundle.evaluations).toHaveLength(2);
    expect(needsQualitativeEvaluation(bundle, false)).toBe(false);
  });

  it("re-evaluates legacy direct-comparison records with the new independent schema", async () => {
    const runs = [run("control", "one", 1), run("treatment", "one", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    const bundle = {
      metadata: { mode: "comparison" },
      runs,
      pairs: [pair],
      evaluations: [{ pair, judgment: { overall: { judgment: "equivalent" } }, qualitativeEligible: true }]
    };
    const evaluated = [];
    expect(needsQualitativeEvaluation(bundle, false)).toBe(true);
    await evaluateBundle({
      bundle,
      config: { requestDelayMs: 0 },
      apiKey: "test-key",
      model: "test-model",
      sanityMode: false,
      evaluator: async ({ pair: evaluatedPair }) => {
        evaluated.push(evaluatedPair.pairId);
        return completedEvaluation(evaluatedPair);
      },
      persist: async () => {}
    });
    expect(evaluated).toEqual([pair.pairId]);
    expect(bundle.evaluations[0].independentAssessments).toBeTruthy();
  });

  it("re-evaluates legacy categorical independent records", async () => {
    const runs = [run("control", "one", 1), run("treatment", "one", 1)];
    const pair = createBlindPairs(runs, "seed")[0];
    const legacyAssessment = {
      criteria: Object.fromEntries(criteriaNames.map((criterion) => [criterion, { rating: "strong", rationale: `${criterion} rationale` }])),
      overall: { rating: "strong", rationale: "Overall rationale" },
      concerns: [],
      confidence: "high"
    };
    const bundle = {
      metadata: { mode: "comparison" },
      runs,
      pairs: [pair],
      evaluations: [{ pair, qualitativeEligible: true, independentAssessments: { control: { assessment: legacyAssessment }, treatment: { assessment: legacyAssessment } } }]
    };
    let calls = 0;
    expect(needsQualitativeEvaluation(bundle, false)).toBe(true);
    await evaluateBundle({
      bundle,
      config: { requestDelayMs: 0 },
      apiKey: "test-key",
      model: "test-model",
      sanityMode: false,
      evaluator: async ({ pair: evaluatedPair }) => {
        calls += 1;
        return completedEvaluation(evaluatedPair);
      },
      persist: async () => {}
    });
    expect(calls).toBe(1);
    expect(bundle.evaluations[0].independentAssessments.control.assessment.overall.rating).toBe(3);
  });

  it("keeps an equivalent control-vs-control sanity set out of arbitration and position-bias counts", async () => {
    const runs = [
      run("control", "one", 1), run("treatment", "one", 1),
      run("control", "two", 1), run("treatment", "two", 1)
    ];
    const pairs = createBlindPairs(runs, "sanity-seed");
    const bundle = { metadata: { mode: "sanity" }, runs, pairs, evaluations: [] };
    let evaluatorCalls = 0;
    let arbitrationCalls = 0;
    await evaluateBundle({
      bundle,
      config: { requestDelayMs: 0 },
      apiKey: "test-key",
      model: "test-model",
      sanityMode: true,
      evaluator: async ({ pair }) => {
        evaluatorCalls += 1;
        return completedEvaluation(pair);
      },
      arbitrator: async () => {
        arbitrationCalls += 1;
        throw new Error("arbitration should not be called for equivalent assessments");
      },
      persist: async () => {}
    });
    const qualitative = aggregateQualitative(bundle.evaluations);
    const sanity = sanityAssessment(qualitative, pairs);
    expect(evaluatorCalls).toBe(2);
    expect(arbitrationCalls).toBe(0);
    expect(qualitative.overall).toMatchObject({ equivalent: 2 });
    expect(sanity).toMatchObject({
      qualitativeEvaluationCompleted: true,
      mappingIsReasonablyBalanced: true,
      positionBiasEvaluated: false,
      obviousPositionBias: false,
      arbitrationRequiredCount: 0,
      arbitrationInstabilityCount: 0
    });
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
    expect(report).toContain("### Independent rating distributions");
    expect(report).toContain("Exception counts: concern 0; unclear 0.");
    expect(report).toContain("Overall rating distribution:");
    expect(report).toContain("| Criterion | Control rating | Control exception | Control confidence | Control rationale |");
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
      assessment(3, { criteria: { synthesis: 4 } }),
      assessment(3, { criteria: { readability: 4 } })
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
