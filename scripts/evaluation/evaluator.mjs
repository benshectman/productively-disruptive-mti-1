import {
  ASSESSMENT_EXCEPTIONS,
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
  required: ["rating", "exception", "confidence", "rationale"],
  properties: {
    rating: { type: "integer", enum: ASSESSMENT_RATINGS },
    exception: { enum: ASSESSMENT_EXCEPTIONS },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
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
      required: ["rating", "exception", "confidence", "rationale"],
      properties: {
        rating: { type: "integer", enum: ASSESSMENT_RATINGS },
        exception: { enum: ASSESSMENT_EXCEPTIONS },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
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
    confidence: { type: "string", enum: ["high", "medium", "low"] }
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
    confidence: { type: "string", enum: ["high", "medium", "low"] }
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
      "Do not infer or speculate about the model, environment, or source of the response. Treat the supplied response as standalone material.",
      "Use only the selected topics, prose, proof items, and evidence supplied. Evaluate the complete narrative.",
      "For every criterion, return an integer quality rating from 1 to 5, a separate exception value, confidence, and concise rationale.",
      "Use this rating scale: 1 Poor means the criterion fails basic expectations and has material deficiencies; 2 Weak means it partially meets expectations but clear shortcomings materially limit the result; 3 Meets Expectations means it is competent and acceptable without notable strengths or deficiencies; 4 Strong means it clearly exceeds baseline expectations with meaningful quality, judgment, or effectiveness beyond competence; 5 Excellent means exceptional execution with unusually strong synthesis, judgment, precision, or effectiveness and little meaningful room for improvement.",
      "A score of 5 should be uncommon. 5 means exceptional, not merely polished or professional. Most competent portfolio content should fall around 3 or 4.",
      "Do not avoid using 2 or 3 simply because writing is grammatically correct or professionally presented. Evaluate the specific criterion, not overall polish alone.",
      "Calibrate the upper end strictly: polished, complete, specific, well-grounded, or professional execution normally earns 4 at most for a criterion unless it shows unusual criterion-specific excellence. A 5 requires a rationale that names what makes the criterion exceptional beyond a 4 and shows little meaningful room for improvement. Do not use 5 merely because there are no defects or concerns. If the rationale could describe many competent portfolio responses, use 3 or 4 instead.",
      "Do not reward verbosity, fact count, or length by themselves.",
      "Set exception to concern only for a concrete issue that may invalidate normal qualitative comparison or materially undermine the response, especially an apparent grounding, attribution, contradiction, or integrity problem. Set exception to unclear only when the supplied material is insufficient to assess the criterion confidently. Otherwise set exception to null.",
      "For overall quality, also return rating, exception, confidence, and rationale. Confidence describes how reliable this independent assessment is, not whether an answer was returned.",
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
    const item = value.criteria[criterion];
    if (!item || !Number.isInteger(item.rating) || !ASSESSMENT_RATINGS.includes(item.rating) || !ASSESSMENT_EXCEPTIONS.includes(item.exception) || !["high", "medium", "low"].includes(item.confidence) || !item.rationale) throw new Error(`Independent evaluator response is missing or invalid ${criterion}`);
  }
  if (!Number.isInteger(value.overall.rating) || !ASSESSMENT_RATINGS.includes(value.overall.rating) || !ASSESSMENT_EXCEPTIONS.includes(value.overall.exception) || !["high", "medium", "low"].includes(value.overall.confidence) || !value.overall.rationale || !["high", "medium", "low"].includes(value.confidence)) throw new Error("Independent evaluator response is missing or invalid overall quality fields");
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
