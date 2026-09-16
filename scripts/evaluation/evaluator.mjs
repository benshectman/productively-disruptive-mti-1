import { CRITERIA, evaluatorRequest, unblindJudgment } from "./core.mjs";

const criterionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["judgment", "rationale"],
  properties: {
    judgment: { type: "string", enum: ["A_stronger", "B_stronger", "equivalent", "concern", "low_confidence"] },
    rationale: { type: "string", minLength: 1, maxLength: 500 }
  }
};

const evaluationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "overall", "concerns", "confidence"],
  properties: {
    criteria: {
      type: "object",
      additionalProperties: false,
      required: CRITERIA,
      properties: Object.fromEntries(CRITERIA.map((criterion) => [criterion, criterionSchema]))
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
  attributionDiscipline: "Does it avoid implying Ben personally performed work that belongs to a team, organization, or shared leadership context?",
  readability: "Does it read like strong portfolio prose rather than a database summary?",
  evidenceEconomy: "Does it use only the evidence necessary to make the point rather than mechanically consuming the available fact pool?"
};

export function buildEvaluatorBody(request, model) {
  return {
    model,
    store: false,
    max_output_tokens: 3500,
    instructions: [
      "You are comparing two versions of professional portfolio prose. The comparison is blind: never infer or speculate which system produced A or B.",
      "Compare like-for-like content using only the selected topics, prose, and evidence supplied. Evaluate the complete narrative, including proof items.",
      "Use comparative judgments, not numeric quality scores. Reserve concern for a concrete issue and low_confidence for evidence too ambiguous to compare.",
      "Do not reward length or fact count by itself. Strong synthesis and evidence economy may be shorter while retaining specificity.",
      "A groundedness concern requires a specific apparent mismatch with supplied evidence. An attribution concern requires a specific shift from team, organization, shared leadership, or leadership attribution into unsupported personal execution.",
      "For overall, choose A_stronger, B_stronger, equivalent, or low_confidence. Explain the most decision-relevant difference concisely.",
      `Criteria definitions: ${JSON.stringify(definitions)}`
    ].join(" "),
    input: JSON.stringify(request),
    text: { format: { type: "json_schema", name: "portfolio_generation_comparison", strict: true, schema: evaluationSchema } }
  };
}

function responseText(result) {
  return result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim() || "";
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

function assertJudgment(value) {
  if (!value || !value.criteria || !value.overall || !Array.isArray(value.concerns)) throw new Error("Evaluator response is missing required fields");
  for (const criterion of CRITERIA) if (!value.criteria[criterion]?.judgment || !value.criteria[criterion]?.rationale) throw new Error(`Evaluator response is missing ${criterion}`);
  return value;
}

export async function evaluatePair({ pair, runsById, apiKey, model, fetcher = fetch, timeoutMs = 60_000 }) {
  const request = evaluatorRequest(pair, runsById);
  const body = buildEvaluatorBody(request, model);
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
    const judgment = assertJudgment(JSON.parse(responseText(rawResponse)));
    return {
      pair,
      startedAt,
      durationMs: Math.round(performance.now() - start),
      evaluatorModel: model,
      judgment,
      unblinded: unblindJudgment(judgment, pair),
      evaluatorRequest: request,
      rawEvaluatorResponse: rawResponse
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { pair, startedAt, durationMs: Math.round(performance.now() - start), evaluatorModel: model, error: message, rawEvaluatorText: rawText };
  } finally {
    clearTimeout(timer);
  }
}
