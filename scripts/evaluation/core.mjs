import { createHash, randomUUID } from "node:crypto";

export const CRITERIA = [
  "topicRelevance",
  "selectivity",
  "synthesis",
  "coherence",
  "nonRepetition",
  "specificity",
  "groundedness",
  "attributionDiscipline",
  "readability",
  "evidenceEconomy"
];

export const ASSESSMENT_RATINGS = ["strong", "adequate", "weak", "concern", "unclear"];
export const QUALITATIVE_CLASSIFICATIONS = ["control_stronger", "treatment_stronger", "equivalent", "unresolved"];

const VALID_TOPICS = new Set(["T-001", "T-002", "T-003", "T-004"]);
const FIELD_NAMES = ["headline", "summary", "detail"];
const QUALITY_RANK = { concern: 0, weak: 1, adequate: 2, strong: 3 };
const CONFIDENCE_RANK = { low: 0, moderate: 1, high: 2 };

export function validateConfig(config) {
  if (!config || config.version !== 1) throw new Error("Evaluation config version must be 1");
  if (!Number.isInteger(config.repetitions) || config.repetitions < 1) throw new Error("repetitions must be a positive integer");
  if (!Array.isArray(config.topicConfigurations) || config.topicConfigurations.length < 1) throw new Error("topicConfigurations must not be empty");
  const ids = new Set();
  for (const item of config.topicConfigurations) {
    if (!item.id || ids.has(item.id)) throw new Error(`Topic configuration IDs must be unique: ${item.id || "missing"}`);
    ids.add(item.id);
    if (!Array.isArray(item.topics) || new Set(item.topics).size !== item.topics.length || item.topics.some((topic) => !VALID_TOPICS.has(topic))) {
      throw new Error(`Invalid topics for configuration ${item.id}`);
    }
  }
  return config;
}

export function resolveEnvironment(config, name, env = process.env) {
  const definition = config.environments?.[name];
  if (!definition) throw new Error(`Missing ${name} environment configuration`);
  const baseUrl = env[definition.urlEnv];
  if (!baseUrl) throw new Error(`Set ${definition.urlEnv} to a branch deploy or Deploy Preview URL`);
  const parsed = new URL(baseUrl);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${definition.urlEnv} must be an HTTP(S) URL`);
  const path = config.generationPath || "/.netlify/functions/generate";
  return {
    name,
    id: env[definition.idEnv] || definition.defaultId || name,
    baseUrl: parsed.origin,
    endpoint: new URL(path, `${parsed.origin}/`).toString()
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function headerValue(headers, name) {
  return headers?.get?.(name) || null;
}

function fieldProvenance(generation) {
  if (!generation?.sections) return [];
  return generation.sections.flatMap((section) => FIELD_NAMES.map((field) => ({
    sectionId: section.id,
    field,
    provenance: section.fields?.[field] || "unknown"
  })));
}

export async function captureGeneration({ environment, topicConfiguration, repetition, timeoutMs = 45_000, fetcher = fetch }) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let rawText = "";
  let networkError = null;
  const requestUrl = new URL(environment.endpoint);
  requestUrl.searchParams.set("diagnostics", "1");
  try {
    response = await fetcher(requestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ designSystem: "astryx", theme: "neutral", topics: topicConfiguration.topics }),
      signal: controller.signal
    });
    rawText = await response.text();
  } catch (error) {
    networkError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Math.round(performance.now() - start);
  const rawResponse = safeJson(rawText);
  const generation = rawResponse?.generation || null;
  const rejectionDiagnosticsAvailable = Array.isArray(generation?.rejections);
  const narrative = rawResponse?.narrative || null;
  const transportStatus = response?.status || 0;
  const generationStatus = headerValue(response?.headers, "x-portfolio-generation-status") || (networkError ? "network-error" : transportStatus === 200 ? "unknown" : "http-error");
  return {
    runId: randomUUID(),
    environment: environment.name,
    environmentId: environment.id,
    endpoint: requestUrl.toString(),
    topicConfigurationId: topicConfiguration.id,
    topicConfigurationLabel: topicConfiguration.label,
    selectedTopicIds: [...topicConfiguration.topics],
    repetition,
    startedAt,
    durationMs,
    httpStatus: transportStatus,
    ok: Boolean(response?.ok && rawResponse?.requestId && narrative),
    requestId: rawResponse?.requestId || null,
    generationStatus,
    upstreamStatus: headerValue(response?.headers, "x-portfolio-upstream-status"),
    validationStatus: headerValue(response?.headers, "x-portfolio-validation-status"),
    diagnostics: generation,
    rejectionDiagnosticsAvailable,
    rejectionCount: rejectionDiagnosticsAvailable ? generation.rejections.length : null,
    totalGeneratedFields: generation?.generatedFields ?? null,
    totalFallbackFields: generation?.fallbackFields ?? null,
    aiSectionCount: generation?.aiSections ?? null,
    mixedSectionCount: generation?.mixedSections ?? null,
    fallbackSectionCount: generation?.fallbackSections ?? null,
    fieldProvenance: fieldProvenance(generation),
    prose: narrative ? extractProse(narrative) : null,
    evidence: rawResponse?.evidence || [],
    networkError,
    rawResponse,
    rawText: rawResponse ? null : rawText
  };
}

export function extractProse(narrative) {
  return {
    mode: narrative.mode || null,
    sections: (narrative.sections || []).map((section) => ({
      id: section.id,
      eyebrow: section.eyebrow,
      headline: section.headline,
      summary: section.summary,
      detail: section.detail || "",
      proofItems: (section.proof_items || []).map((item) => ({
        projectId: item.project_id,
        projectName: item.project_name,
        relevance: item.relevance,
        situation: item.situation,
        task: item.task,
        actions: item.actions,
        results: item.results,
        summary: item.summary
      }))
    }))
  };
}

function percentile(values, proportion) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(proportion * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function aggregateReliability(runs, regressionConfig = {}) {
  const byEnvironment = {};
  for (const environment of ["control", "treatment"]) {
    const selected = runs.filter((run) => run.environment === environment);
    const validDiagnostics = selected.filter((run) => run.diagnostics);
    const durations = selected.map((run) => run.durationMs).filter(Number.isFinite);
    const fallbackFields = validDiagnostics.reduce((sum, run) => sum + (run.totalFallbackFields || 0), 0);
    const totalFields = validDiagnostics.reduce((sum, run) => sum + (run.diagnostics.totalFields || 0), 0);
    const fullyFallbackSections = validDiagnostics.reduce((sum, run) => sum + (run.fallbackSectionCount || 0), 0);
    const sectionsWithAnyFallback = validDiagnostics.reduce((sum, run) => sum + (run.fallbackSectionCount || 0) + (run.mixedSectionCount || 0), 0);
    const totalSections = validDiagnostics.reduce((sum, run) => sum + (run.diagnostics.totalSections || 0), 0);
    const rejectionDiagnosticRuns = validDiagnostics.filter((run) => Array.isArray(run.diagnostics.rejections));
    const rejections = rejectionDiagnosticRuns.flatMap((run) => run.diagnostics.rejections);
    const fallbackBySection = {};
    const fallbackByTopicConfiguration = {};
    for (const run of validDiagnostics) {
      fallbackByTopicConfiguration[run.topicConfigurationId] = (fallbackByTopicConfiguration[run.topicConfigurationId] || 0) + (run.totalFallbackFields || 0);
      for (const field of (run.fieldProvenance || []).filter((item) => item.provenance === "fallback")) {
        const key = `${field.sectionId}.${field.field}`;
        fallbackBySection[key] = (fallbackBySection[key] || 0) + 1;
      }
    }
    byEnvironment[environment] = {
      runs: selected.length,
      successfulRuns: selected.filter((run) => run.ok).length,
      fullyGeneratedRuns: validDiagnostics.filter((run) => run.diagnostics.status === "ai").length,
      fallbackFields,
      totalFields,
      fallbackFieldRate: totalFields ? fallbackFields / totalFields : null,
      fullyFallbackSections,
      sectionsWithAnyFallback,
      totalSections,
      fallbackSectionRate: totalSections ? sectionsWithAnyFallback / totalSections : null,
      generationStatuses: countBy(selected, (run) => run.generationStatus),
      validationFailures: countBy(selected.filter((run) => run.validationStatus), (run) => run.validationStatus),
      rejectionDiagnosticsAvailableRuns: rejectionDiagnosticRuns.length,
      rejectionCount: rejections.length,
      runsWithRejections: rejectionDiagnosticRuns.filter((run) => run.diagnostics.rejections.length > 0).length,
      rejectionsByCategory: countBy(rejections, (rejection) => rejection.category),
      rejectionsBySection: countBy(rejections, (rejection) => rejection.sectionId),
      rejectionsByField: countBy(rejections, (rejection) => rejection.field),
      fallbackBySection,
      fallbackByTopicConfiguration,
      latencyMs: {
        median: percentile(durations, 0.5),
        minimum: durations.length ? Math.min(...durations) : null,
        maximum: durations.length ? Math.max(...durations) : null,
        p90: durations.length >= 10 ? percentile(durations, 0.9) : null
      }
    };
  }
  const control = byEnvironment.control;
  const treatment = byEnvironment.treatment;
  const fieldDifference = treatment.fallbackFields - control.fallbackFields;
  const rateDifference = (treatment.fallbackFieldRate ?? 0) - (control.fallbackFieldRate ?? 0);
  const materialRegression = fieldDifference >= (regressionConfig.minimumAdditionalFallbackFields ?? 2)
    && rateDifference >= (regressionConfig.minimumFallbackRateIncrease ?? 0.01);
  return { byEnvironment, comparison: { fallbackFieldDifference: fieldDifference, fallbackRateDifference: rateDifference, materialRegression } };
}

function countBy(values, keyer) {
  return Object.fromEntries([...values.reduce((map, value) => {
    const key = keyer(value) || "unknown";
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map())]);
}

function hashBit(value) {
  return createHash("sha256").update(value).digest()[0] & 1;
}

export function generationType(run) {
  if (!run?.ok) return "capture-failure";
  const fallbackFields = Number(run.totalFallbackFields ?? run.diagnostics?.fallbackFields ?? 0);
  const hasFallbackProvenance = (run.fieldProvenance || []).some((item) => item.provenance === "fallback");
  const status = run.generationStatus || run.diagnostics?.status;
  return fallbackFields > 0 || hasFallbackProvenance || status === "mixed" || status === "fallback" ? "fallback" : "generated";
}

export function classifyPairEligibility(control, treatment) {
  const controlType = generationType(control);
  const treatmentType = generationType(treatment);
  if (controlType === "capture-failure" || treatmentType === "capture-failure") {
    return {
      kind: "capture-failure",
      controlType,
      treatmentType,
      qualitativeEligible: false,
      reason: "Both environments must return a successful narrative before the pair can be assessed."
    };
  }
  if (controlType === "generated" && treatmentType === "generated") {
    return { kind: "generated-vs-generated", controlType, treatmentType, qualitativeEligible: true, reason: null };
  }
  if (controlType === "fallback" && treatmentType === "fallback") {
    return { kind: "fallback-vs-fallback", controlType, treatmentType, qualitativeEligible: false, reason: "Fallback-vs-fallback is a reliability event, not a prose-quality comparison." };
  }
  return { kind: "generated-vs-fallback", controlType, treatmentType, qualitativeEligible: false, reason: "Generated-vs-fallback is a reliability event, not a prose-quality comparison." };
}

export function createBlindPairs(runs, seed) {
  const controls = new Map(runs.filter((run) => run.environment === "control").map((run) => [`${run.topicConfigurationId}:${run.repetition}`, run]));
  const treatments = new Map(runs.filter((run) => run.environment === "treatment").map((run) => [`${run.topicConfigurationId}:${run.repetition}`, run]));
  const candidates = [...controls.entries()].filter(([key, run]) => run.ok && treatments.get(key)?.ok)
    .sort(([left], [right]) => createHash("sha256").update(`${seed}:${left}`).digest("hex").localeCompare(createHash("sha256").update(`${seed}:${right}`).digest("hex")));
  const initialControlIsA = hashBit(seed) === 0;
  return candidates.map(([key, control], index) => {
    const treatment = treatments.get(key);
    const controlIsA = index % 2 === 0 ? initialControlIsA : !initialControlIsA;
    const blind = {
      A: controlIsA ? control.runId : treatment.runId,
      B: controlIsA ? treatment.runId : control.runId
    };
    const mapping = {
      A: controlIsA ? "control" : "treatment",
      B: controlIsA ? "treatment" : "control"
    };
    return {
      pairId: createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 16),
      topicConfigurationId: control.topicConfigurationId,
      topicConfigurationLabel: control.topicConfigurationLabel,
      selectedTopicIds: control.selectedTopicIds,
      repetition: control.repetition,
      controlRunId: control.runId,
      treatmentRunId: treatment.runId,
      blind,
      mapping,
      arbitrationPlacement: {
        strategy: "seeded-counterbalanced",
        A: mapping.A,
        B: mapping.B,
        runIds: { ...blind }
      },
      eligibility: classifyPairEligibility(control, treatment)
    };
  });
}

export function independentAssessmentRequest(run, pair) {
  return {
    topicConfiguration: { id: pair.topicConfigurationId, label: pair.topicConfigurationLabel, topics: pair.selectedTopicIds },
    response: { prose: run.prose, evidence: run.evidence }
  };
}

export function arbitrationRequest(pair, runsById) {
  const a = runsById.get(pair.blind.A);
  const b = runsById.get(pair.blind.B);
  return {
    topicConfiguration: { id: pair.topicConfigurationId, label: pair.topicConfigurationLabel, topics: pair.selectedTopicIds },
    responseA: { prose: a.prose, evidence: a.evidence },
    responseB: { prose: b.prose, evidence: b.evidence }
  };
}

// Kept as a compatibility alias for callers that used the former pairwise request name.
export function evaluatorRequest(pair, runsById) {
  return arbitrationRequest(pair, runsById);
}

export function mirrorPair(pair) {
  const blind = { A: pair.blind.B, B: pair.blind.A };
  const mapping = { A: pair.mapping.B, B: pair.mapping.A };
  return {
    ...pair,
    pairId: `${pair.pairId}-mirrored`,
    mirroredFromPairId: pair.pairId,
    blind,
    mapping,
    arbitrationPlacement: {
      ...(pair.arbitrationPlacement || {}),
      A: mapping.A,
      B: mapping.B,
      runIds: { ...blind },
      mirroredFromPairId: pair.pairId
    }
  };
}

export function unblindJudgment(judgment, pair) {
  const translate = (value) => value === "A_stronger" ? pair.mapping.A
    : value === "B_stronger" ? pair.mapping.B
      : value === "low_confidence" ? "unresolved"
        : value;
  return {
    ...judgment,
    criteria: Object.fromEntries(CRITERIA.map((criterion) => [criterion, {
      ...judgment.criteria[criterion],
      environmentResult: translate(judgment.criteria[criterion].judgment)
    }])),
    overall: { ...judgment.overall, environmentResult: translate(judgment.overall.judgment) },
    concerns: (judgment.concerns || []).map((concern) => ({
      ...concern,
      environments: (concern.responses || []).map((response) => pair.mapping[response]).filter(Boolean)
    }))
  };
}

function compareRating(left, right) {
  if (left === right) return "equivalent";
  if (left === "unclear" || right === "unclear" || left == null || right == null) return "unresolved";
  if (!(left in QUALITY_RANK) || !(right in QUALITY_RANK)) return "unresolved";
  return QUALITY_RANK[left] > QUALITY_RANK[right] ? "control_stronger" : "treatment_stronger";
}

function assessmentCriterion(assessment, criterion) {
  return assessment?.criteria?.[criterion]?.rating || assessment?.criteria?.[criterion]?.assessment || null;
}

function assessmentOverall(assessment) {
  return assessment?.overall?.rating || assessment?.overall?.assessment || null;
}

function lowestConfidence(left, right) {
  const leftRank = CONFIDENCE_RANK[left] ?? 0;
  const rightRank = CONFIDENCE_RANK[right] ?? 0;
  return leftRank <= rightRank ? (left || "low") : (right || "low");
}

function classificationToEnvironmentResult(classification) {
  if (classification === "control_stronger") return "control";
  if (classification === "treatment_stronger") return "treatment";
  if (classification === "unresolved") return "unresolved";
  return "equivalent";
}

export function compareIndependentAssessments(controlAssessment, treatmentAssessment) {
  const criteria = Object.fromEntries(CRITERIA.map((criterion) => {
    const controlRating = assessmentCriterion(controlAssessment, criterion);
    const treatmentRating = assessmentCriterion(treatmentAssessment, criterion);
    return [criterion, {
      controlRating,
      treatmentRating,
      result: compareRating(controlRating, treatmentRating),
      controlRationale: controlAssessment?.criteria?.[criterion]?.rationale || "",
      treatmentRationale: treatmentAssessment?.criteria?.[criterion]?.rationale || ""
    }];
  }));
  const criterionResults = Object.values(criteria).map((item) => item.result);
  const controlCriterionWins = criterionResults.filter((result) => result === "control_stronger").length;
  const treatmentCriterionWins = criterionResults.filter((result) => result === "treatment_stronger").length;
  const hasControlCriteria = controlCriterionWins > 0;
  const hasTreatmentCriteria = treatmentCriterionWins > 0;
  const criteriaConflict = hasControlCriteria && hasTreatmentCriteria;
  const minimumCriterionLead = 3;
  const criterionDirection = criteriaConflict ? "unresolved"
    : controlCriterionWins >= minimumCriterionLead ? "control_stronger"
      : treatmentCriterionWins >= minimumCriterionLead ? "treatment_stronger"
        : null;
  const controlOverall = assessmentOverall(controlAssessment);
  const treatmentOverall = assessmentOverall(treatmentAssessment);
  const overallResult = compareRating(controlOverall, treatmentOverall);
  const overallDirection = ["control_stronger", "treatment_stronger"].includes(overallResult) ? overallResult : null;
  const overallLowConfidence = controlOverall === "low_confidence" || treatmentOverall === "low_confidence";
  const lowConfidence = controlAssessment?.confidence === "low" || treatmentAssessment?.confidence === "low" || overallLowConfidence;
  const criterionOpposesOverall = (overallDirection === "control_stronger" && treatmentCriterionWins > 0)
    || (overallDirection === "treatment_stronger" && controlCriterionWins > 0);
  let classification = "equivalent";
  let reason = "The independent assessments are effectively tied across the overall and criterion-level ratings.";
  if (lowConfidence && (overallDirection || criterionDirection)) {
    classification = "unresolved";
    reason = "At least one independent assessment reported low confidence, so the apparent difference is not treated as decisive.";
  } else if (criteriaConflict) {
    classification = "unresolved";
    reason = "The criterion-level assessments point in opposite directions, so the pair is sent to arbitration.";
  } else if (criterionOpposesOverall) {
    classification = "unresolved";
    reason = "The overall ratings and at least one criterion-level rating point in opposite directions, so the pair is sent to arbitration.";
  } else if (overallDirection && criterionDirection && overallDirection !== criterionDirection) {
    classification = "unresolved";
    reason = "The overall ratings and criterion-level ratings point in opposite directions, so the pair is sent to arbitration.";
  } else if (overallDirection || criterionDirection) {
    classification = overallDirection || criterionDirection;
    reason = overallDirection && criterionDirection
      ? `Both the overall ratings and criterion-level ratings favor ${classification === "control_stronger" ? "control" : "treatment"}.`
      : `The available structured ratings favor ${classification === "control_stronger" ? "control" : "treatment"}.`;
  } else if (controlCriterionWins || treatmentCriterionWins) {
    reason = `Overall ratings tied, and the isolated criterion difference (${controlCriterionWins} control, ${treatmentCriterionWins} treatment) did not reach the three-criterion threshold for a meaningful advantage.`;
  }
  const confidence = classification === "unresolved"
    ? "low"
    : criterionResults.includes("unresolved")
      ? lowestConfidence(lowestConfidence(controlAssessment?.confidence, treatmentAssessment?.confidence), "moderate")
      : lowestConfidence(controlAssessment?.confidence, treatmentAssessment?.confidence);
  return {
    classification,
    confidence,
    reason,
    overall: {
      controlRating: controlOverall,
      treatmentRating: treatmentOverall,
      result: overallResult
    },
    criteria,
    criterionDirection,
    criteriaConflict,
    criterionOpposesOverall,
    unclearCriteriaCount: criterionResults.filter((result) => result === "unresolved").length,
    criterionCounts: { control: controlCriterionWins, treatment: treatmentCriterionWins, equivalent: CRITERIA.length - controlCriterionWins - treatmentCriterionWins },
    minimumCriterionLead
  };
}

function independentConcerns(controlAssessment, treatmentAssessment) {
  return [
    ...(controlAssessment?.concerns || []).map((concern) => ({ ...concern, response: "control", environments: ["control"] })),
    ...(treatmentAssessment?.concerns || []).map((concern) => ({ ...concern, response: "treatment", environments: ["treatment"] }))
  ];
}

export function deterministicUnblindedOutcome(comparison, controlAssessment, treatmentAssessment) {
  return {
    criteria: Object.fromEntries(CRITERIA.map((criterion) => {
      const item = comparison.criteria[criterion];
      return [criterion, {
        judgment: item.result,
        environmentResult: classificationToEnvironmentResult(item.result),
        rationale: item.result === "control_stronger" ? item.controlRationale
          : item.result === "treatment_stronger" ? item.treatmentRationale
            : item.result === "equivalent" ? "Both independent assessments gave the same criterion rating."
              : "The criterion could not be resolved deterministically."
      }];
    })),
    overall: {
      judgment: comparison.classification,
      environmentResult: classificationToEnvironmentResult(comparison.classification),
      rationale: comparison.reason
    },
    concerns: independentConcerns(controlAssessment, treatmentAssessment)
  };
}

function blindJudgment(environmentResult, pair) {
  if (environmentResult === pair.mapping.A) return "A_stronger";
  if (environmentResult === pair.mapping.B) return "B_stronger";
  if (environmentResult === "unresolved") return "low_confidence";
  return environmentResult;
}

function lowerConfidence(left, right) {
  return lowestConfidence(left, right);
}

export function reconcileMirroredArbitrations(original, mirrored) {
  if (original.error || mirrored.error) throw new Error("Cannot reconcile failed arbitration passes");
  const pair = original.pair;
  const criterionDisagreements = [];
  const criteria = Object.fromEntries(CRITERIA.map((criterion) => {
    const first = original.unblinded.criteria[criterion].environmentResult;
    const second = mirrored.unblinded.criteria[criterion].environmentResult;
    const agrees = first === second;
    if (!agrees) criterionDisagreements.push(criterion);
    return [criterion, {
      judgment: agrees ? blindJudgment(first, pair) : "low_confidence",
      rationale: agrees
        ? `Mirrored arbitration passes agreed. ${original.judgment.criteria[criterion].rationale}`
        : `Order-sensitive criterion result. Original orientation: ${first}. Mirrored orientation: ${second}.`
    }];
  }));
  const originalOverall = original.unblinded.overall.environmentResult;
  const mirroredOverall = mirrored.unblinded.overall.environmentResult;
  const positionSensitive = originalOverall !== mirroredOverall;
  const concerns = [];
  for (const [orientation, evaluation] of [["original", original], ["mirrored", mirrored]]) {
    for (const concern of evaluation.unblinded.concerns || []) {
      concerns.push({
        type: concern.type,
        responses: concern.environments.map((environment) => environment === pair.mapping.A ? "A" : "B"),
        rationale: `${orientation} orientation: ${concern.rationale}`
      });
    }
  }
  const judgment = {
    criteria,
    overall: {
      judgment: positionSensitive ? "low_confidence" : blindJudgment(originalOverall, pair),
      rationale: positionSensitive
        ? `Order-sensitive arbitration result. Original orientation: ${originalOverall}. Mirrored orientation: ${mirroredOverall}.`
        : `Mirrored arbitration passes agreed on ${originalOverall}. ${original.judgment.overall.rationale}`
    },
    concerns,
    confidence: positionSensitive || criterionDisagreements.length ? "low" : lowerConfidence(original.judgment.confidence, mirrored.judgment.confidence)
  };
  return {
    pair,
    startedAt: original.startedAt,
    durationMs: (original.durationMs || 0) + (mirrored.durationMs || 0),
    evaluatorModel: original.evaluatorModel,
    judgment,
    unblinded: unblindJudgment(judgment, pair),
    mirrorAudit: {
      positionSensitive,
      exactAgreement: !positionSensitive && criterionDisagreements.length === 0,
      originalOverall,
      mirroredOverall,
      criterionDisagreements
    },
    evaluatorPasses: { original, mirrored }
  };
}

// Compatibility alias for the former direct-pairwise sanity helper.
export function reconcileMirroredEvaluations(original, mirrored) {
  return reconcileMirroredArbitrations(original, mirrored);
}

function isQualitativeEvaluation(evaluation) {
  return evaluation?.qualitativeEligible !== false && evaluation?.pair?.eligibility?.qualitativeEligible !== false && !evaluation?.error;
}

function evaluationClassification(evaluation) {
  if (evaluation.final?.classification) return evaluation.final.classification;
  const result = evaluation.unblinded?.overall?.environmentResult;
  if (result === "control") return "control_stronger";
  if (result === "treatment") return "treatment_stronger";
  if (result === "unresolved" || result === "low_confidence") return "unresolved";
  return "equivalent";
}

function criterionEnvironmentResult(evaluation, criterion) {
  if (evaluation.final?.criteria?.[criterion]?.environmentResult) return evaluation.final.criteria[criterion].environmentResult;
  return evaluation.unblinded?.criteria?.[criterion]?.environmentResult || "unresolved";
}

function finalConfidence(evaluation) {
  return evaluation.final?.confidence || evaluation.judgment?.confidence || "low";
}

function arbitrationPassRecords(evaluations) {
  const records = [];
  for (const evaluation of evaluations) {
    if (evaluation.arbitration?.judgment) {
      records.push({ evaluation, pass: "original", pair: evaluation.arbitration.pair, judgment: evaluation.arbitration.judgment, unblinded: evaluation.arbitration.unblinded });
    }
    if (evaluation.arbitrationMirror?.judgment) {
      records.push({ evaluation, pass: "mirrored", pair: evaluation.arbitrationMirror.pair, judgment: evaluation.arbitrationMirror.judgment, unblinded: evaluation.arbitrationMirror.unblinded });
    }
    if (!evaluation.arbitration && evaluation.judgment?.overall?.judgment?.startsWith?.("A_")) {
      records.push({ evaluation, pass: "legacy", pair: evaluation.pair, judgment: evaluation.judgment, unblinded: evaluation.unblinded });
    }
  }
  return records;
}

function positionBiasAudit(evaluations) {
  const records = arbitrationPassRecords(evaluations);
  const position = {
    A: { appeared: 0, wins: 0, equivalent: 0, unresolved: 0, decisive: 0 },
    B: { appeared: 0, wins: 0, equivalent: 0, unresolved: 0, decisive: 0 }
  };
  const environment = {
    control: { asA: 0, asB: 0, winsAsA: 0, winsAsB: 0 },
    treatment: { asA: 0, asB: 0, winsAsA: 0, winsAsB: 0 }
  };
  for (const record of records) {
    const { pair, judgment, unblinded } = record;
    const overall = judgment.overall.judgment;
    const result = unblinded.overall.environmentResult;
    for (const side of ["A", "B"]) {
      position[side].appeared += 1;
      if (overall === `${side}_stronger`) {
        position[side].wins += 1;
        position[side].decisive += 1;
      } else if (overall === "equivalent") position[side].equivalent += 1;
      else if (overall === "low_confidence") position[side].unresolved += 1;
    }
    const aEnvironment = pair.mapping.A;
    const bEnvironment = pair.mapping.B;
    environment[aEnvironment].asA += 1;
    environment[bEnvironment].asB += 1;
    if (result === aEnvironment) environment[aEnvironment].winsAsA += 1;
    if (result === bEnvironment) environment[bEnvironment].winsAsB += 1;
  }
  const decisiveComparisons = position.A.decisive + position.B.decisive;
  return {
    arbitrationRequiredCount: evaluations.filter((evaluation) => evaluation.arbitrationRequired).length,
    arbitrationCompletedCount: records.filter((record) => record.pass === "original").length,
    arbitrationPassCount: records.length,
    arbitrationInstabilityCount: evaluations.filter((evaluation) => evaluation.mirrorAudit?.positionSensitive).length,
    controlAsA: environment.control.asA,
    controlAsB: environment.control.asB,
    treatmentAsA: environment.treatment.asA,
    treatmentAsB: environment.treatment.asB,
    aOverallWins: position.A.wins,
    bOverallWins: position.B.wins,
    decisiveComparisons,
    byPresentedPosition: position,
    byEnvironmentPlacement: environment
  };
}

export function aggregateQualitative(evaluations) {
  const eligible = evaluations.filter(isQualitativeEvaluation);
  const criteria = {};
  for (const criterion of CRITERIA) {
    criteria[criterion] = countBy(eligible, (evaluation) => criterionEnvironmentResult(evaluation, criterion));
  }
  const audit = positionBiasAudit(eligible);
  const mirroredEvaluations = eligible.filter((evaluation) => evaluation.mirrorAudit);
  const excluded = evaluations.filter((evaluation) => !isQualitativeEvaluation(evaluation));
  return {
    comparablePairs: eligible.length,
    excludedPairs: countBy(excluded, (evaluation) => evaluation.pair?.eligibility?.kind || "ineligible"),
    criteria,
    criterionComparisons: criteria,
    overall: countBy(eligible, evaluationClassification),
    confidence: countBy(eligible, finalConfidence),
    concerns: {
      control: eligible.filter((evaluation) => (evaluation.unblinded?.concerns || []).some((concern) => ["grounding", "attribution"].includes(concern.type) && (concern.environments || []).includes("control"))).length,
      treatment: eligible.filter((evaluation) => (evaluation.unblinded?.concerns || []).some((concern) => ["grounding", "attribution"].includes(concern.type) && (concern.environments || []).includes("treatment"))).length
    },
    arbitrationRequiredCount: audit.arbitrationRequiredCount,
    arbitrationInstabilityCount: audit.arbitrationInstabilityCount,
    positionBiasAudit: audit,
    // Compatibility shape retained for consumers of the earlier report schema.
    blindPosition: {
      controlAsA: audit.controlAsA,
      controlAsB: audit.controlAsB,
      aOverallWins: audit.aOverallWins,
      bOverallWins: audit.bOverallWins
    },
    mirrorAudit: mirroredEvaluations.length ? {
      evaluatedPairs: mirroredEvaluations.length,
      positionSensitivePairs: mirroredEvaluations.filter((evaluation) => evaluation.mirrorAudit.positionSensitive).length,
      exactAgreementPairs: mirroredEvaluations.filter((evaluation) => evaluation.mirrorAudit.exactAgreement).length,
      pairsWithCriterionDisagreement: mirroredEvaluations.filter((evaluation) => evaluation.mirrorAudit.criterionDisagreements.length).length
    } : null
  };
}

export function chooseShortlist(evaluations, runsById, limits = {}) {
  const minimum = limits.minimum ?? 5;
  const maximum = limits.maximum ?? 10;
  const reasonsFor = (evaluation) => {
    const reasons = [];
    const result = evaluationClassification(evaluation);
    if (result === "treatment_stronger") reasons.push("apparent improvement");
    if (result === "control_stronger") reasons.push("apparent regression");
    if (result === "equivalent") reasons.push("no meaningful difference");
    if (result === "unresolved") reasons.push("unresolved qualitative result");
    if (finalConfidence(evaluation) === "low") reasons.push("low evaluator confidence");
    if (evaluation.arbitrationRequired) reasons.push("blinded arbitration required");
    if (evaluation.mirrorAudit?.positionSensitive) reasons.push("position-sensitive arbitration result");
    else if (evaluation.mirrorAudit?.criterionDisagreements.length) reasons.push("mirrored arbitration disagreement");
    if ((evaluation.unblinded?.concerns || []).length) reasons.push(...evaluation.unblinded.concerns.map((item) => `${item.type} concern`));
    const a = runsById.get(evaluation.pair.blind.A);
    const b = runsById.get(evaluation.pair.blind.B);
    if ((a?.totalFallbackFields || 0) > 0 || (b?.totalFallbackFields || 0) > 0) reasons.push("fallback case");
    return [...new Set(reasons)];
  };
  const ranked = evaluations.filter(isQualitativeEvaluation).map((evaluation) => {
    const reasons = reasonsFor(evaluation);
    const result = evaluationClassification(evaluation);
    return {
      evaluation,
      reasons,
      priority: ((evaluation.unblinded?.concerns || []).length * 20)
        + (finalConfidence(evaluation) === "low" ? 12 : 0)
        + (evaluation.mirrorAudit?.positionSensitive ? 18 : 0)
        + (evaluation.arbitrationRequired ? 8 : 0)
        + (result === "control_stronger" ? 10 : 0)
        + (result === "treatment_stronger" ? 6 : 0)
        + (result === "equivalent" ? 2 : 0)
    };
  }).sort((a, b) => b.priority - a.priority || a.evaluation.pair.pairId.localeCompare(b.evaluation.pair.pairId));
  const chosen = [];
  const add = (predicate) => {
    const item = ranked.find((candidate) => predicate(candidate) && !chosen.includes(candidate));
    if (item && chosen.length < maximum) chosen.push(item);
  };
  add((item) => item.reasons.includes("apparent improvement"));
  add((item) => item.reasons.includes("apparent regression"));
  add((item) => item.reasons.includes("grounding concern") || item.reasons.includes("attribution concern"));
  add((item) => item.reasons.includes("unresolved qualitative result"));
  add((item) => item.reasons.includes("low evaluator confidence"));
  add((item) => item.reasons.includes("position-sensitive arbitration result"));
  add((item) => item.reasons.includes("mirrored arbitration disagreement"));
  add((item) => item.reasons.includes("no meaningful difference"));
  for (const item of ranked) if (chosen.length < minimum && !chosen.includes(item)) chosen.push(item);
  return chosen.slice(0, maximum).map(({ evaluation, reasons }) => ({ ...evaluation, shortlistReasons: reasons }));
}

export function sanityAssessment(qualitative, pairs = []) {
  const eligiblePairs = pairs.filter((pair) => pair.eligibility?.qualitativeEligible !== false);
  const audit = qualitative?.positionBiasAudit;
  const controlAsA = audit?.controlAsA ?? eligiblePairs.filter((pair) => pair.mapping.A === "control").length;
  const controlAsB = audit?.controlAsB ?? eligiblePairs.filter((pair) => pair.mapping.B === "control").length;
  const decisive = audit?.decisiveComparisons ?? 0;
  const aWins = audit?.aOverallWins ?? 0;
  const bWins = audit?.bOverallWins ?? 0;
  const sideShare = decisive ? Math.max(aWins, bWins) / decisive : 0;
  const largerSideWins = Math.max(aWins, bWins);
  let positionBiasPValue = null;
  if (qualitative && decisive) {
    let coefficient = 1;
    let upperTail = 0;
    for (let wins = 0; wins <= decisive; wins += 1) {
      if (wins >= largerSideWins) upperTail += coefficient;
      coefficient = coefficient * (decisive - wins) / (wins + 1);
    }
    positionBiasPValue = Math.min(1, (2 * upperTail) / (2 ** decisive));
  }
  const mappingDifference = Math.abs(controlAsA - controlAsB);
  return {
    qualitativeEvaluationCompleted: Boolean(qualitative),
    mirroredEvaluationCompleted: Boolean(qualitative?.mirrorAudit),
    mirroredPairs: qualitative?.mirrorAudit?.evaluatedPairs ?? 0,
    positionSensitivePairs: qualitative?.mirrorAudit?.positionSensitivePairs ?? null,
    arbitrationRequiredCount: qualitative?.arbitrationRequiredCount ?? 0,
    arbitrationInstabilityCount: qualitative?.arbitrationInstabilityCount ?? 0,
    controlAsA,
    controlAsB,
    mappingIsReasonablyBalanced: mappingDifference <= 1,
    positionBiasEvaluated: Boolean(qualitative && decisive),
    obviousPositionBias: qualitative ? (decisive ? positionBiasPValue <= 0.05 : false) : null,
    decisiveComparisons: decisive,
    largerBlindSideShare: sideShare,
    positionBiasPValue
  };
}
