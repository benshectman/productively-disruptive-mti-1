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

const VALID_TOPICS = new Set(["T-001", "T-002", "T-003", "T-004"]);
const FIELD_NAMES = ["headline", "summary", "detail"];

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
  try {
    response = await fetcher(environment.endpoint, {
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
  const narrative = rawResponse?.narrative || null;
  const transportStatus = response?.status || 0;
  const generationStatus = headerValue(response?.headers, "x-portfolio-generation-status") || (networkError ? "network-error" : transportStatus === 200 ? "unknown" : "http-error");
  return {
    runId: randomUUID(),
    environment: environment.name,
    environmentId: environment.id,
    endpoint: environment.endpoint,
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
    const fallbackFields = validDiagnostics.reduce((sum, run) => sum + run.totalFallbackFields, 0);
    const totalFields = validDiagnostics.reduce((sum, run) => sum + (run.diagnostics.totalFields || 0), 0);
    const fullyFallbackSections = validDiagnostics.reduce((sum, run) => sum + run.fallbackSectionCount, 0);
    const sectionsWithAnyFallback = validDiagnostics.reduce((sum, run) => sum + run.fallbackSectionCount + (run.mixedSectionCount || 0), 0);
    const totalSections = validDiagnostics.reduce((sum, run) => sum + (run.diagnostics.totalSections || 0), 0);
    const fallbackBySection = {};
    const fallbackByTopicConfiguration = {};
    for (const run of validDiagnostics) {
      fallbackByTopicConfiguration[run.topicConfigurationId] = (fallbackByTopicConfiguration[run.topicConfigurationId] || 0) + run.totalFallbackFields;
      for (const field of run.fieldProvenance.filter((item) => item.provenance === "fallback")) {
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

export function createBlindPairs(runs, seed) {
  const controls = new Map(runs.filter((run) => run.environment === "control").map((run) => [`${run.topicConfigurationId}:${run.repetition}`, run]));
  const treatments = new Map(runs.filter((run) => run.environment === "treatment").map((run) => [`${run.topicConfigurationId}:${run.repetition}`, run]));
  const candidates = [...controls.entries()].filter(([key, run]) => run.ok && treatments.get(key)?.ok)
    .sort(([left], [right]) => createHash("sha256").update(`${seed}:${left}`).digest("hex").localeCompare(createHash("sha256").update(`${seed}:${right}`).digest("hex")));
  const initialControlIsA = hashBit(seed) === 0;
  return candidates.map(([key, control], index) => {
    const treatment = treatments.get(key);
    // Seeded order plus alternation keeps A/B assignment reproducible, randomized,
    // and balanced enough to make a position-bias sanity check meaningful.
    const controlIsA = index % 2 === 0 ? initialControlIsA : !initialControlIsA;
    return {
      pairId: createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 16),
      topicConfigurationId: control.topicConfigurationId,
      topicConfigurationLabel: control.topicConfigurationLabel,
      selectedTopicIds: control.selectedTopicIds,
      repetition: control.repetition,
      blind: {
        A: controlIsA ? control.runId : treatment.runId,
        B: controlIsA ? treatment.runId : control.runId
      },
      mapping: {
        A: controlIsA ? "control" : "treatment",
        B: controlIsA ? "treatment" : "control"
      }
    };
  });
}

export function evaluatorRequest(pair, runsById) {
  const a = runsById.get(pair.blind.A);
  const b = runsById.get(pair.blind.B);
  return {
    topicConfiguration: { id: pair.topicConfigurationId, label: pair.topicConfigurationLabel, topics: pair.selectedTopicIds },
    responseA: { prose: a.prose, evidence: a.evidence },
    responseB: { prose: b.prose, evidence: b.evidence }
  };
}

export function unblindJudgment(judgment, pair) {
  const translate = (value) => value === "A_stronger" ? pair.mapping.A : value === "B_stronger" ? pair.mapping.B : value;
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

export function aggregateQualitative(evaluations) {
  const criteria = {};
  for (const criterion of CRITERIA) {
    criteria[criterion] = countBy(evaluations, (evaluation) => evaluation.unblinded.criteria[criterion].environmentResult);
  }
  return {
    comparablePairs: evaluations.length,
    criteria,
    overall: countBy(evaluations, (evaluation) => evaluation.unblinded.overall.environmentResult),
    confidence: countBy(evaluations, (evaluation) => evaluation.judgment.confidence),
    concerns: {
      control: evaluations.filter((evaluation) => evaluation.unblinded.concerns.some((concern) => ["grounding", "attribution"].includes(concern.type) && concern.environments.includes("control"))).length,
      treatment: evaluations.filter((evaluation) => evaluation.unblinded.concerns.some((concern) => ["grounding", "attribution"].includes(concern.type) && concern.environments.includes("treatment"))).length
    },
    blindPosition: {
      controlAsA: evaluations.filter((evaluation) => evaluation.pair.mapping.A === "control").length,
      controlAsB: evaluations.filter((evaluation) => evaluation.pair.mapping.B === "control").length,
      aOverallWins: evaluations.filter((evaluation) => evaluation.judgment.overall.judgment === "A_stronger").length,
      bOverallWins: evaluations.filter((evaluation) => evaluation.judgment.overall.judgment === "B_stronger").length
    }
  };
}

export function chooseShortlist(evaluations, runsById, limits = {}) {
  const minimum = limits.minimum ?? 5;
  const maximum = limits.maximum ?? 10;
  const reasonsFor = (evaluation) => {
    const reasons = [];
    const result = evaluation.unblinded.overall.environmentResult;
    if (result === "treatment") reasons.push("apparent improvement");
    if (result === "control") reasons.push("apparent regression");
    if (result === "equivalent") reasons.push("no meaningful difference");
    if (evaluation.judgment.confidence === "low") reasons.push("low evaluator confidence");
    if (evaluation.unblinded.concerns.length) reasons.push(...evaluation.unblinded.concerns.map((item) => `${item.type} concern`));
    const a = runsById.get(evaluation.pair.blind.A);
    const b = runsById.get(evaluation.pair.blind.B);
    if ((a.totalFallbackFields || 0) > 0 || (b.totalFallbackFields || 0) > 0) reasons.push("fallback case");
    return [...new Set(reasons)];
  };
  const ranked = evaluations.map((evaluation) => ({
    evaluation,
    reasons: reasonsFor(evaluation),
    priority: (evaluation.unblinded.concerns.length * 20)
      + (evaluation.judgment.confidence === "low" ? 12 : 0)
      + (evaluation.unblinded.overall.environmentResult === "control" ? 10 : 0)
      + (evaluation.unblinded.overall.environmentResult === "treatment" ? 6 : 0)
      + (evaluation.unblinded.overall.environmentResult === "equivalent" ? 2 : 0)
      + Object.values(evaluation.unblinded.criteria).filter((item) => item.environmentResult === evaluation.unblinded.overall.environmentResult).length
  })).sort((a, b) => b.priority - a.priority || a.evaluation.pair.pairId.localeCompare(b.evaluation.pair.pairId));
  const chosen = [];
  const add = (predicate) => {
    const item = ranked.find((candidate) => predicate(candidate) && !chosen.includes(candidate));
    if (item && chosen.length < maximum) chosen.push(item);
  };
  add((item) => item.reasons.includes("apparent improvement"));
  add((item) => item.reasons.includes("apparent regression"));
  add((item) => item.reasons.includes("fallback case"));
  add((item) => item.reasons.some((reason) => reason.includes("grounding") || reason.includes("attribution")));
  add((item) => item.reasons.includes("low evaluator confidence"));
  add((item) => item.reasons.includes("no meaningful difference"));
  for (const item of ranked) if (chosen.length < minimum && !chosen.includes(item)) chosen.push(item);
  return chosen.slice(0, maximum).map(({ evaluation, reasons }) => ({ ...evaluation, shortlistReasons: reasons }));
}

export function sanityAssessment(qualitative, pairs = []) {
  const controlAsA = qualitative?.blindPosition.controlAsA ?? pairs.filter((pair) => pair.mapping.A === "control").length;
  const controlAsB = qualitative?.blindPosition.controlAsB ?? pairs.filter((pair) => pair.mapping.B === "control").length;
  const decisive = qualitative ? qualitative.blindPosition.aOverallWins + qualitative.blindPosition.bOverallWins : 0;
  const sideShare = decisive ? Math.max(qualitative.blindPosition.aOverallWins, qualitative.blindPosition.bOverallWins) / decisive : 0;
  const mappingDifference = Math.abs(controlAsA - controlAsB);
  return {
    qualitativeEvaluationCompleted: Boolean(qualitative),
    controlAsA,
    controlAsB,
    mappingIsReasonablyBalanced: mappingDifference <= 1,
    obviousPositionBias: qualitative ? decisive >= 8 && sideShare >= 0.75 : null,
    decisiveComparisons: decisive,
    largerBlindSideShare: sideShare
  };
}
