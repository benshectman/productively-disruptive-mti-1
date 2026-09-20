import {
  ASSESSMENT_RATINGS,
  CRITERIA,
  arbitrationRequest,
  classifyPairEligibility,
  compareIndependentAssessments,
  deterministicUnblindedOutcome,
  independentAssessmentRequest,
  mirrorPair,
  reconcileMirroredArbitrations,
  unblindJudgment
} from "./core.mjs";

const assessmentCriterionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rating", "rationale"],
  properties: {
    rating: { type: "string", enum: ASSESSMENT_RATINGS },
    rationale: { type: "string", minLength: 1, maxLength: 500 }
  }
};

const independentAssessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "overall", "concerns", "confidence"],
  properties: {
    criteria: {
      type: "object",
      additionalProperties: false,
      required: CRITERIA,
      properties: Object.fromEntries(CRITERIA.map((criterion) => [criterion, assessmentCriterionSchema]))
    },
    overall: {
      type: "object",
      additionalProperties: false,
      required: ["rating", "rationale"],
      properties: {
        rating: { type: "string", enum: ["strong", "adequate", "weak", "concern", "low_confidence"] },
        rationale: { type: "string", minLength: 1, maxLength: 800 }
      }
    },
    concerns: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "rationale"],
        properties: {
          type: { type: "string", enum: ["grounding", "attribution", "repetition", "other"] },
          rationale: { type: "string", minLength: 1, maxLength: 500 }
        }
      }
    },
    confidence: { type: "string", enum: ["high", "moderate", "low"] }
  }
};

const arbitrationCriterionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["judgment", "rationale"],
  properties: {
    judgment: { type: "string", enum: ["A_stronger", "B_stronger", "equivalent", "concern", "low_confidence"] },
    rationale: { type: "string", minLength: 1, maxLength: 500 }
  }
};

const arbitrationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "overall", "concerns", "confidence"],
  properties: {
    criteria: {
      type: "object",
      additionalProperties: false,
      required: CRITERIA,
      properties: Object.fromEntries(CRITERIA.map((criterion) => [criterion, arbitrationCriterionSchema]))
    },
    overall: {
      type: "object",
      additionalProperties: false,
      required: ["judgment", "rationale"],
      properties: {
        judgment: { type: "string", enum: ["A_stronger", "B_stronger", "equivalent", "low_confidence"] },
        rationale: { type: "string", minLength: 1, maxLength: 800 }
      }
    },
    concerns: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "responses", "rationale"],
        properties: {
          type: { type: "string", enum: ["grounding", "attribution", "repetition", "other"] },
          responses: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["A", "B"] } },
          rationale: { type: "string", minLength: 1, maxLength: 500 }
        }
      }
    },
    confidence: { type: "string", enum: ["high", "moderate", "low"] }
  }
};

const definitions = {
  topicRelevance: "Does the prose meaningfully reflect the selected topics?",
  selectivity: "Does it prioritize the most useful evidence rather than trying to mention everything?",
  synthesis: "Does it combine related evidence into coherent ideas rather than paraphrasing facts one by one?",
  coherence: "Does the section make a clear argument or tell a coherent story?",
  nonRepetition: "Does it avoid repeating the same ideas across lead/detail or neighboring sections?",
  specificity: "Does it retain meaningful evidence rather than collapsing into generic leadership language?",
  groundedness: "Does any statement appear unsupported by the supplied evidence?",
  attributionDiscipline: "Does it avoid implying Ben personally performed work that belongs to a team, organization, shared leadership context, or leadership context?",
  readability: "Does it read like strong portfolio prose rather than a database summary?",
  evidenceEconomy: "Does it use only the evidence necessary to make the point rather than mechanically consuming the available fact pool?"
};

export function buildIndependentAssessmentBody(request, model) {
  return {
    model,
    store: false,
    max_output_tokens: 3500,
    instructions: [
      "Assess one version of professional portfolio prose on its own merits. There is no competing response in this task.",
      "Do not infer or speculate about the model, environment, or source of the response. Do not label the response as control or treatment.",
      "Use only the selected topics, prose, proof items, and evidence supplied. Evaluate the complete narrative.",
      "For every criterion, use strong, adequate, weak, concern, or unclear. Use concern only for a concrete issue, especially an apparent grounding or attribution problem. Use unclear when the supplied material is insufficient.",
      "For overall quality, use strong, adequate, weak, concern, or low_confidence. Give a concise rationale. Confidence describes how reliable this independent assessment is, not whether an answer was returned.",
      "Do not reward length or fact count by itself. Strong synthesis and evidence economy may be shorter while retaining specificity.",
      "A groundedness concern requires a specific apparent mismatch with supplied evidence. An attribution concern requires a specific shift from team, organization, shared leadership, or leadership attribution into unsupported personal execution.",
      `Criteria definitions: ${JSON.stringify(definitions)}`
    ].join(" "),
    input: JSON.stringify(request),
    text: { format: { type: "json_schema", name: "portfolio_generation_response_assessment", strict: true, schema: independentAssessmentSchema } }
  };
}

export function buildArbitrationBody(request, model) {
  return {
    model,
    store: false,
    max_output_tokens: 3500,
    instructions: [
      "You are a blinded tie-breaker for two otherwise unresolved versions of professional portfolio prose.",
      "A and B are arbitrary presentation labels. Never infer or speculate which system, model, branch, or environment produced either response.",
      "Compare like-for-like content using only the selected topics, prose, proof items, and evidence supplied. Evaluate the complete narrative.",
      "Return A_stronger, B_stronger, equivalent, or low_confidence for overall. Do not force a winner when the evidence remains weak or ambiguous.",
      "Use concern for a concrete criterion-level issue. A groundedness concern requires a specific apparent mismatch with supplied evidence. An attribution concern requires a specific shift from team, organization, shared leadership, or leadership attribution into unsupported personal execution.",
      "Do not reward length or fact count by itself. Strong synthesis and evidence economy may be shorter while retaining specificity.",
      `Criteria definitions: ${JSON.stringify(definitions)}`
    ].join(" "),
    input: JSON.stringify(request),
    text: { format: { type: "json_schema", name: "portfolio_generation_blinded_arbitration", strict: true, schema: arbitrationSchema } }
  };
}

// Compatibility alias for callers that used the former direct-comparison builder.
export function buildEvaluatorBody(request, model) {
  return buildArbitrationBody(request, model);
}

function responseText(result) {
  return result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim() || "";
}

function assertIndependentAssessment(value) {
  if (!value || !value.criteria || !value.overall || !Array.isArray(value.concerns)) throw new Error("Independent evaluator response is missing required fields");
  for (const criterion of CRITERIA) {
    if (!value.criteria[criterion]?.rating || !value.criteria[criterion]?.rationale) throw new Error(`Independent evaluator response is missing ${criterion}`);
  }
  return value;
}

function assertArbitration(value) {
  if (!value || !value.criteria || !value.overall || !Array.isArray(value.concerns)) throw new Error("Arbitration response is missing required fields");
  for (const criterion of CRITERIA) {
    if (!value.criteria[criterion]?.judgment || !value.criteria[criterion]?.rationale) throw new Error(`Arbitration response is missing ${criterion}`);
  }
  return value;
}

async function postEvaluator({ body, apiKey, fetcher, timeoutMs, parse }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let response;
  let rawText = "";
  try {
    response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    rawText = await response.text();
    if (!response.ok) throw new Error(`Evaluator HTTP ${response.status}`);
    const rawResponse = JSON.parse(rawText);
    const judgment = parse(JSON.parse(responseText(rawResponse)));
    return { startedAt, durationMs: Math.round(performance.now() - start), rawResponse, judgment };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { startedAt, durationMs: Math.round(performance.now() - start), error: message, rawEvaluatorText: rawText };
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightEvaluator({ apiKey, model, fetcher = fetch, timeoutMs = 30_000 }) {
  const marker = "EVALUATOR_PREFLIGHT_OK";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 32,
        instructions: `This is a connectivity preflight. Reply with exactly ${marker}.`,
        input: "Confirm evaluator connectivity using the required marker. No portfolio or evidence data is included."
      }),
      signal: controller.signal
    });
    const rawText = await response.text();
    if (!response.ok) throw new Error(`Evaluator preflight HTTP ${response.status}`);
    const result = JSON.parse(rawText);
    if (!responseText(result).includes(marker)) throw new Error("Evaluator preflight response did not contain the expected marker");
    return { startedAt, completedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start), evaluatorModel: model };
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateIndependentResponse({ run, pair, apiKey, model, fetcher = fetch, timeoutMs = 60_000 }) {
  const request = independentAssessmentRequest(run, pair);
  const body = buildIndependentAssessmentBody(request, model);
  const result = await postEvaluator({ body, apiKey, fetcher, timeoutMs, parse: assertIndependentAssessment });
  return {
    runId: run.runId,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    evaluatorModel: model,
    assessment: result.judgment,
    evaluatorRequest: request,
    rawEvaluatorResponse: result.rawResponse,
    ...(result.error ? { error: result.error, rawEvaluatorText: result.rawEvaluatorText } : {})
  };
}

export async function evaluateArbitration({ pair, runsById, apiKey, model, fetcher = fetch, timeoutMs = 60_000 }) {
  const request = arbitrationRequest(pair, runsById);
  const body = buildArbitrationBody(request, model);
  const result = await postEvaluator({ body, apiKey, fetcher, timeoutMs, parse: assertArbitration });
  if (result.error) {
    return {
      pair,
      placement: { ...(pair.arbitrationPlacement || {}), mapping: { ...pair.mapping } },
      startedAt: result.startedAt,
      durationMs: result.durationMs,
      evaluatorModel: model,
      error: result.error,
      rawEvaluatorText: result.rawEvaluatorText
    };
  }
  return {
    pair,
    placement: { ...(pair.arbitrationPlacement || {}), mapping: { ...pair.mapping } },
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    evaluatorModel: model,
    judgment: result.judgment,
    unblinded: unblindJudgment(result.judgment, pair),
    evaluatorRequest: request,
    rawEvaluatorResponse: result.rawResponse
  };
}

function classificationFromEnvironmentResult(result) {
  if (result === "control") return "control_stronger";
  if (result === "treatment") return "treatment_stronger";
  if (result === "unresolved") return "unresolved";
  return "equivalent";
}

function finalCriteriaFromUnblinded(unblinded) {
  return Object.fromEntries(CRITERIA.map((criterion) => [criterion, {
    environmentResult: unblinded.criteria[criterion].environmentResult,
    judgment: unblinded.criteria[criterion].judgment,
    rationale: unblinded.criteria[criterion].rationale
  }]));
}

function combineConcerns(first, second) {
  return [...(first || []), ...(second || [])];
}

export async function evaluatePair({
  pair,
  runsById,
  apiKey,
  model,
  fetcher = fetch,
  timeoutMs = 60_000,
  assessor = evaluateIndependentResponse,
  arbitrator = evaluateArbitration,
  mirrorArbitration = false
}) {
  const controlPosition = pair.mapping.A === "control" ? "A" : "B";
  const treatmentPosition = pair.mapping.A === "treatment" ? "A" : "B";
  const controlRun = runsById.get(pair.controlRunId || pair.blind[controlPosition]);
  const treatmentRun = runsById.get(pair.treatmentRunId || pair.blind[treatmentPosition]);
  const eligibility = pair.eligibility || classifyPairEligibility(controlRun, treatmentRun);
  if (!pair.eligibility) pair = { ...pair, eligibility };
  if (!eligibility.qualitativeEligible) {
    return {
      pair,
      excluded: true,
      qualitativeEligible: false,
      finalPairClassification: "excluded",
      exclusion: eligibility,
      exclusionReason: eligibility.reason || "Pair is not eligible for prose-quality comparison."
    };
  }
  const [controlAssessment, treatmentAssessment] = await Promise.all([
    assessor({ run: controlRun, pair, apiKey, model, fetcher, timeoutMs }),
    assessor({ run: treatmentRun, pair, apiKey, model, fetcher, timeoutMs })
  ]);
  if (controlAssessment.error || treatmentAssessment.error) {
    return {
      pair,
      qualitativeEligible: true,
      evaluationStage: "independent-assessment",
      independentAssessments: { control: controlAssessment, treatment: treatmentAssessment },
      error: controlAssessment.error || treatmentAssessment.error
    };
  }
  const deterministicComparison = compareIndependentAssessments(controlAssessment.assessment, treatmentAssessment.assessment);
  const deterministicUnblinded = deterministicUnblindedOutcome(deterministicComparison, controlAssessment.assessment, treatmentAssessment.assessment);
  const base = {
    pair,
    qualitativeEligible: true,
    independentAssessments: { control: controlAssessment, treatment: treatmentAssessment },
    deterministicComparison,
    arbitrationRequired: deterministicComparison.classification === "unresolved",
    arbitration: null,
    arbitrationMirror: null,
    final: {
      source: "deterministic",
      classification: deterministicComparison.classification,
      confidence: deterministicComparison.confidence,
      rationale: deterministicComparison.reason,
      criteria: finalCriteriaFromUnblinded(deterministicUnblinded)
    },
    unblinded: deterministicUnblinded
  };
  if (!base.arbitrationRequired) return base;
  const arbitration = await arbitrator({ pair, runsById, apiKey, model, fetcher, timeoutMs });
  if (arbitration.error) {
    return {
      ...base,
      evaluationStage: "arbitration",
      error: arbitration.error,
      arbitration
    };
  }
  const unblinded = {
    ...arbitration.unblinded,
    concerns: combineConcerns(deterministicUnblinded.concerns, arbitration.unblinded.concerns)
  };
  const arbitrationResult = {
    source: "arbitration",
    classification: classificationFromEnvironmentResult(unblinded.overall.environmentResult),
    confidence: arbitration.judgment.confidence,
    rationale: arbitration.judgment.overall.rationale,
    criteria: finalCriteriaFromUnblinded(unblinded),
    instability: false
  };
  if (!mirrorArbitration) return { ...base, arbitration, final: arbitrationResult, unblinded };

  const mirrored = await arbitrator({ pair: mirrorPair(pair), runsById, apiKey, model, fetcher, timeoutMs });
  if (mirrored.error) {
    return {
      ...base,
      arbitration,
      arbitrationMirror: mirrored,
      mirrorError: mirrored.error,
      evaluationStage: "mirrored-arbitration",
      error: mirrored.error
    };
  }
  const reconciled = reconcileMirroredArbitrations(arbitration, mirrored);
  const finalUnblinded = {
    ...reconciled.unblinded,
    concerns: combineConcerns(deterministicUnblinded.concerns, reconciled.unblinded.concerns)
  };
  return {
    ...base,
    arbitration,
    arbitrationMirror: mirrored,
    mirrorAudit: reconciled.mirrorAudit,
    final: {
      source: "mirrored-arbitration",
      classification: classificationFromEnvironmentResult(finalUnblinded.overall.environmentResult),
      confidence: reconciled.judgment.confidence,
      rationale: reconciled.judgment.overall.rationale,
      criteria: finalCriteriaFromUnblinded(finalUnblinded),
      instability: reconciled.mirrorAudit.positionSensitive
    },
    unblinded: finalUnblinded
  };
}
