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
import {
  mapTournamentJudgment,
  TOURNAMENT_CONFIDENCE,
  TOURNAMENT_MARGINS,
  TOURNAMENT_WINNERS,
  tournamentRequest
} from "./tournament.mjs";
import {
  buildProviderRequest,
  normalizeProviderUsage,
  parseEvaluatorJson,
  providerResponseText
} from "./evaluator-provider.mjs";

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

const tournamentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["winner", "margin", "confidence", "rationale"],
  properties: {
    winner: { type: "string", enum: TOURNAMENT_WINNERS },
    margin: { type: "string", enum: TOURNAMENT_MARGINS },
    confidence: { type: "string", enum: TOURNAMENT_CONFIDENCE },
    rationale: { type: "string", minLength: 1, maxLength: 700 }
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

const independentDefinitions = {
  ...definitions,
  topicRelevance: "Considering both the eligible evidence and the final prose, did the response select and emphasize evidence that most directly advances the selected topics?",
  selectivity: "Did the response choose the strongest and most discriminating evidence from the eligible pool, while excluding weaker, redundant, or tangential alternatives?",
  evidenceEconomy: "Does each included fact contribute meaningfully, and does the response avoid using additional evidence when fewer, stronger facts would make the point more effectively?"
};

export const INDEPENDENT_CRITERION_RUBRICS = {
  topicRelevance: {
    1: "The response is substantially unrelated to the selected topics or emphasizes evidence that does not advance them.",
    2: "It addresses some selected topics but misses major aspects, gives tangential evidence too much prominence, or handles multiple topics unevenly.",
    3: "It clearly addresses the selected topics using reasonably relevant evidence. The emphasis is appropriate but not especially discerning or insightful.",
    4: "It maintains sharp topical focus and gives the most relevant evidence appropriate prominence, with little tangential material.",
    5: "It makes unusually discerning topic-to-evidence choices, especially across competing or overlapping topics. The rationale identifies the non-obvious prioritization that makes the framing exceptional."
  },
  selectivity: {
    1: "Evidence choices are arbitrary, weak, substantially irrelevant, or omit the strongest available material.",
    2: "Some useful evidence is chosen, but stronger alternatives are missed or weaker, redundant, or tangential facts materially dilute the response.",
    3: "The selected evidence is reasonable and supports the response. Some stronger choices or tighter exclusions may have been possible.",
    4: "The response prioritizes high-value, discriminating evidence and excludes most weaker or redundant alternatives.",
    5: "The response demonstrates exceptional editorial judgment across a genuinely meaningful choice set. The rationale identifies specific strong choices and plausible alternatives appropriately excluded or subordinated."
  },
  synthesis: {
    1: "Evidence remains disconnected, contradictory, or assembled without a coherent idea.",
    2: "The response primarily lists or paraphrases facts, with limited connection among them.",
    3: "Related evidence is combined into coherent claims or themes, although some seams or fact-by-fact construction remain visible.",
    4: "Evidence is integrated into clear higher-order ideas, relationships, or arguments that add meaning beyond the individual facts.",
    5: "The response produces an unusually insightful, precise, and fully grounded interpretation or relationship that is not obvious from the facts individually."
  },
  coherence: {
    1: "The response lacks a discernible argument, sequence, or narrative logic.",
    2: "The main point can be inferred, but sections or ideas feel fragmented, poorly ordered, or weakly connected.",
    3: "The response has a clear and understandable progression. Most sections and transitions support the main point.",
    4: "The ordering, section roles, and transitions form a deliberate progression that strengthens the argument.",
    5: "The narrative architecture is exceptionally effective. Each section materially advances the argument, and the sequence creates meaning or persuasive force that a merely logical arrangement would not."
  },
  nonRepetition: {
    1: "Substantial ideas, claims, or evidence are repeated without adding value.",
    2: "Repetition is noticeable across leads, details, or sections and weakens momentum or economy.",
    3: "The response avoids material redundancy. Minor repetition may remain but does not significantly impair the narrative.",
    4: "Each section and disclosure layer contributes distinct value, with repetition used only when it serves orientation or emphasis.",
    5: "The response handles substantially overlapping evidence with exceptional differentiation and compression. Similar material is assigned distinct roles without redundancy or loss of clarity; merely having no repetition earns no more than 4."
  },
  specificity: {
    1: "The response relies primarily on generic assertions, abstractions, or unsupported leadership language.",
    2: "Some concrete detail appears, but important claims remain vague, generalized, or detached from meaningful evidence.",
    3: "The response includes enough concrete evidence, examples, roles, and outcomes to make its claims credible and understandable.",
    4: "Specific details are consistently well chosen and connected to claims. Metrics, scope, roles, and outcomes retain their meaning without unnecessary detail.",
    5: "The response achieves unusual precision throughout. Details are discriminating, correctly bounded, and exceptionally effective at clarifying contribution and impact without creating clutter."
  },
  groundedness: {
    1: "Multiple or central claims are unsupported, contradicted, or materially exceed the supplied evidence; concern will usually also apply.",
    2: "One or more important claims involve unsupported inference, distorted scope, or weak evidentiary support; concern may apply when concrete.",
    3: "Claims are generally supported by the supplied evidence, with ordinary paraphrasing and no material unsupported leap.",
    4: "Claims are carefully bounded to what the evidence supports. Metrics, causation, scope, and contextual qualifications are preserved with notable discipline.",
    5: "Complex or potentially ambiguous evidence is handled with exceptional precision. Fine distinctions, limitations, and evidentiary boundaries are preserved throughout; merely finding no unsupported claim earns no more than 3 or 4."
  },
  attributionDiscipline: {
    1: "The response repeatedly or materially converts team, organizational, shared-leadership, or leadership work into unsupported personal execution; concern will usually also apply.",
    2: "Ownership is frequently ambiguous or at least one important contribution is attributed more personally than the evidence supports.",
    3: "Attribution is generally consistent with the supplied evidence, with no material distortion of Ben's role.",
    4: "The response consistently distinguishes personal action, leadership accountability, team execution, shared leadership, and organizational outcomes with notable precision.",
    5: "The response handles genuinely complex or mixed ownership exceptionally well, communicating Ben's contribution clearly without either overstating or obscuring it; merely avoiding an attribution error earns no more than 3 or 4."
  },
  readability: {
    1: "The prose is difficult to understand because of structure, wording, density, jargon, or grammatical problems.",
    2: "Meaning is recoverable, but awkward phrasing, excessive density, weak transitions, or mechanical construction materially impede reading.",
    3: "The prose is clear, professional, and understandable. It communicates the content effectively without a notable stylistic strength or weakness.",
    4: "The prose is engaging, controlled, and easy to follow. Sentence structure, pacing, transitions, and vocabulary support the meaning effectively.",
    5: "Complex material feels unusually clear and effortless. Voice, pacing, and structure reinforce meaning throughout, with no meaningful opportunity to tighten or clarify the prose."
  },
  evidenceEconomy: {
    1: "Evidence is mechanically accumulated, substantially redundant, or so poorly proportioned that the main point is obscured.",
    2: "The response contains too much low-value detail, repeats similar proof, or gives evidence disproportionate space relative to its contribution.",
    3: "The amount of evidence is appropriate. Most included facts contribute, although some pruning or rebalancing may improve focus.",
    4: "Evidence is deployed deliberately and proportionately. The response achieves strong depth and credibility without unnecessary accumulation.",
    5: "The response achieves exceptional evidentiary efficiency. Every included fact performs a distinct, high-value role, and the rationale explains why the chosen amount and combination are materially better than plausible leaner or fuller alternatives."
  }
};

export const INDEPENDENT_OVERALL_RUBRIC = {
  1: "Material failures across several criteria make the response ineffective.",
  2: "The response has some competent elements but is materially limited by multiple weaknesses or one major weakness.",
  3: "The response is professionally competent and acceptable overall. Strengths and weaknesses are limited or roughly balanced.",
  4: "The response is clearly strong overall, with several criterion-level strengths and no major deficiency.",
  5: "The response is exceptional as a whole. Multiple criteria must genuinely reach 5, the strengths must reinforce one another, and no meaningful criterion-level improvement may remain."
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
      "The response field citedEvidence contains the evidence returned with the finished narrative. The eligibleEvidence field contains the section and project evidence pools that were available for selection. When assessing topic relevance, selectivity, and evidence economy, compare the finished prose and cited evidence with those eligible alternatives.",
      "For every criterion, return an integer quality rating from 1 to 5, a separate exception value, confidence, and concise rationale.",
      "Use this rating scale: 1 Poor means the criterion fails basic expectations and has material deficiencies; 2 Weak means it partially meets expectations but clear shortcomings materially limit the result; 3 Meets Expectations means it is competent and acceptable without notable strengths or deficiencies; 4 Strong means it clearly exceeds baseline expectations with meaningful quality, judgment, or effectiveness beyond competence; 5 Excellent means exceptional execution with unusually strong synthesis, judgment, precision, or effectiveness and little meaningful room for improvement.",
      "A score of 5 should be uncommon. 5 means exceptional, not merely polished or professional. Most competent portfolio content should fall around 3 or 4.",
      "Do not avoid using 2 or 3 simply because writing is grammatically correct or professionally presented. Evaluate the specific criterion, not overall polish alone.",
      "Apply ratings independently. A strong impression in one dimension must not elevate unrelated dimensions. Do not impose a numerical cap on 5 ratings, but every 5 must independently satisfy its criterion-specific anchor.",
      "If a criterion rationale identifies a meaningful improvement, that criterion cannot receive 5. A 5 rationale must identify an observable exceptional feature rather than merely restating the criterion. Absence of a problem normally supports 3; notably disciplined execution may support 4. Polished, professional, clear, specific, or well-supported work normally earns 3 or 4 unless the criterion-specific 5 anchor is actually met.",
      "Do not reward complexity, verbosity, evidence count, metric count, fact count, or length by themselves.",
      "Set exception to concern only for a concrete issue that may invalidate normal qualitative comparison or materially undermine the response, especially an apparent grounding, attribution, contradiction, or integrity problem. Set exception to unclear only when the supplied material is insufficient to assess the criterion confidently. Otherwise set exception to null.",
      "Exceptions remain separate from ratings. When using concern or unclear, still return the best numeric estimate and low confidence when appropriate; deterministic comparison handles the exception separately.",
      "For overall quality, also return rating, exception, confidence, and rationale. Overall is not a mathematical average. Overall 5 requires multiple genuine criterion-level 5 ratings whose strengths reinforce one another, and it is invalid if the overall rationale or any materially important criterion rationale identifies a meaningful improvement. Confidence describes how reliable this independent assessment is, not whether an answer was returned.",
      "A groundedness concern requires a specific apparent mismatch with supplied evidence. An attribution concern requires a specific shift from team, organization, shared leadership, or leadership attribution into unsupported personal execution.",
      `Criteria definitions: ${JSON.stringify(independentDefinitions)}`,
      `Criterion-specific rating anchors: ${JSON.stringify(INDEPENDENT_CRITERION_RUBRICS)}`,
      `Overall rating anchors: ${JSON.stringify(INDEPENDENT_OVERALL_RUBRIC)}`
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

export function buildTournamentBody(request, model) {
  return {
    model,
    store: false,
    max_output_tokens: 1800,
    instructions: [
      "You are making a blinded editorial publishing decision between two versions of professional portfolio prose created for the same brief, selected topics, and evidence context.",
      "Both may be competent or high quality. If only one could be published, choose the stronger complete portfolio experience.",
      "A and B are arbitrary presentation labels. Never infer or speculate which model, system, branch, environment, or generation process produced either response.",
      "Evaluate each response as a whole. Section-level observations may support the rationale, but do not rank sections separately.",
      "The shared evidenceContext contains the section and project evidence pools available for the selected topics and proof projects. Each response's citedEvidence contains the evidence returned with that finished narrative. Use both when assessing evidence selection, grounding, and attribution. Do not call a claim unsupported when the shared evidenceContext supports it.",
      "Prefer stronger editorial judgment, synthesis, framing, evidence use, clarity, coherence, concision and economy, articulation of Ben's contribution, and memorability without sacrificing grounding or attribution discipline.",
      "Do not reward verbosity, fact count, metric count, length, or complexity by itself.",
      "For a normal valid comparison, choose A_stronger or B_stronger even when the difference is slight. There is no ordinary equivalent option.",
      "Use unclear only when a defensible comparison is impossible because of insufficient information or another concrete problem. Do not use unclear merely because both responses are strong or similar.",
      "Report margin as slight, clear, or substantial and confidence as low, medium, or high. Margin describes the size of the editorial advantage. Confidence describes certainty in the comparison.",
      "Give a concise rationale naming the editorial distinction that drove the choice, such as synthesis, framing, evidence selection, repetition, detail, throughline, role articulation, structure, or proportionality between claim and proof.",
      "Do not infer anything about the model or environment that produced either response."
    ].join(" "),
    input: JSON.stringify(request),
    text: { format: { type: "json_schema", name: "portfolio_generation_tournament_preference", strict: true, schema: tournamentSchema } }
  };
}

// Compatibility alias for callers that used the former direct-comparison builder.
export function buildEvaluatorBody(request, model) {
  return buildArbitrationBody(request, model);
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

function assertTournamentJudgment(value) {
  const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
  if (!value || !TOURNAMENT_WINNERS.includes(value.winner) || !TOURNAMENT_MARGINS.includes(value.margin)
    || !TOURNAMENT_CONFIDENCE.includes(value.confidence) || typeof value.rationale !== "string" || !value.rationale.trim()
    || JSON.stringify(keys) !== JSON.stringify(["confidence", "margin", "rationale", "winner"])) {
    throw new Error("Tournament evaluator response is missing or invalid required fields");
  }
  return value;
}

export async function postEvaluator({ body, apiKey, provider = "openai", fetcher, timeoutMs, parse }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let response;
  let rawText = "";
  try {
    const request = buildProviderRequest({ provider, apiKey, body, signal: controller.signal });
    response = await fetcher(request.url, request.init);
    rawText = await response.text();
    if (!response.ok) throw new Error(`Evaluator HTTP ${response.status}`);
    const rawResponse = JSON.parse(rawText);
    const judgment = parse(parseEvaluatorJson(providerResponseText(rawResponse, provider)));
    return { startedAt, durationMs: Math.round(performance.now() - start), rawResponse, judgment };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { startedAt, durationMs: Math.round(performance.now() - start), error: message, rawEvaluatorText: rawText };
  } finally {
    clearTimeout(timer);
  }
}

export async function preflightEvaluator({ apiKey, model, provider = "openai", fetcher = fetch, timeoutMs = 30_000 }) {
  const marker = "EVALUATOR_PREFLIGHT_OK";
  const openRouter = provider === "openrouter";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const request = buildProviderRequest({
      provider,
      apiKey,
      signal: controller.signal,
      body: {
        model,
        store: false,
        max_output_tokens: openRouter ? 256 : 32,
        instructions: openRouter
          ? `This is a connectivity preflight. Return only strict JSON exactly matching {"status":"${marker}"}. Do not use Markdown fences or add commentary.`
          : `This is a connectivity preflight. Reply with exactly ${marker}.`,
        input: openRouter
          ? "Confirm evaluator connectivity using the required strict JSON object. No portfolio or evidence data is included."
          : "Confirm evaluator connectivity using the required marker. No portfolio or evidence data is included."
      }
    });
    const response = await fetcher(request.url, request.init);
    const rawText = await response.text();
    if (!response.ok) throw new Error(`Evaluator preflight HTTP ${response.status}`);
    const result = JSON.parse(rawText);
    const responseText = providerResponseText(result, provider);
    if (openRouter) {
      const parsed = parseEvaluatorJson(responseText);
      if (!parsed || Object.keys(parsed).length !== 1 || parsed.status !== marker) throw new Error("Evaluator preflight response did not contain the expected strict JSON marker");
    } else if (!responseText.includes(marker)) throw new Error("Evaluator preflight response did not contain the expected marker");
    return {
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - start),
      evaluatorModel: model,
      evaluatorProvider: provider,
      usage: normalizeProviderUsage(result.usage, provider)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateIndependentResponse({ run, pair, apiKey, model, provider = "openai", fetcher = fetch, timeoutMs = 60_000 }) {
  const request = independentAssessmentRequest(run, pair);
  const body = buildIndependentAssessmentBody(request, model);
  const result = await postEvaluator({ body, apiKey, provider, fetcher, timeoutMs, parse: assertIndependentAssessment });
  return {
    runId: run.runId,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    evaluatorModel: model,
    evaluatorProvider: provider,
    assessment: result.judgment,
    evaluatorRequest: request,
    rawEvaluatorResponse: result.rawResponse,
    ...(result.error ? { error: result.error, rawEvaluatorText: result.rawEvaluatorText } : {})
  };
}

export async function evaluateArbitration({ pair, runsById, apiKey, model, provider = "openai", fetcher = fetch, timeoutMs = 60_000 }) {
  const request = arbitrationRequest(pair, runsById);
  const body = buildArbitrationBody(request, model);
  const result = await postEvaluator({ body, apiKey, provider, fetcher, timeoutMs, parse: assertArbitration });
  if (result.error) {
    return {
      pair,
      placement: { ...(pair.arbitrationPlacement || {}), mapping: { ...pair.mapping } },
      startedAt: result.startedAt,
      durationMs: result.durationMs,
      evaluatorModel: model,
      evaluatorProvider: provider,
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
    evaluatorProvider: provider,
    judgment: result.judgment,
    unblinded: unblindJudgment(result.judgment, pair),
    evaluatorRequest: request,
    rawEvaluatorResponse: result.rawResponse
  };
}

export async function evaluateTournamentComparison({ comparison, runsById, apiKey, model, provider = "openai", fetcher = fetch, timeoutMs = 60_000, maxAttempts = 2, retryDelayMs = 0 }) {
  const request = tournamentRequest(comparison, runsById);
  const body = buildTournamentBody(request, model);
  const attempts = [];
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await postEvaluator({ body, apiKey, provider, fetcher, timeoutMs, parse: assertTournamentJudgment });
    attempts.push({ attempt, startedAt: result.startedAt, durationMs: result.durationMs, error: result.error || null });
    if (!result.error) break;
    if (attempt < maxAttempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
  }
  const base = {
    comparison,
    placement: {
      ...comparison.placement,
      candidateMapping: {
        A: { ...comparison.mappedCandidates.A },
        B: { ...comparison.mappedCandidates.B }
      }
    },
    startedAt: result.startedAt,
    durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    attemptCount: attempts.length,
    attempts,
    evaluatorModel: model,
    evaluatorProvider: provider
  };
  if (result.error) return { ...base, error: result.error, rawEvaluatorText: result.rawEvaluatorText };
  return {
    ...base,
    judgment: result.judgment,
    mappedJudgment: mapTournamentJudgment(comparison, result.judgment),
    evaluatorRequest: request,
    rawEvaluatorResponse: result.rawResponse,
    usage: normalizeProviderUsage(result.rawResponse?.usage, provider)
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
    controlException: unblinded.criteria[criterion].controlException,
    treatmentException: unblinded.criteria[criterion].treatmentException,
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
  provider = "openai",
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
    assessor({ run: controlRun, pair, apiKey, model, provider, fetcher, timeoutMs }),
    assessor({ run: treatmentRun, pair, apiKey, model, provider, fetcher, timeoutMs })
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
  const arbitration = await arbitrator({ pair, runsById, apiKey, model, provider, fetcher, timeoutMs });
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

  const mirrored = await arbitrator({ pair: mirrorPair(pair), runsById, apiKey, model, provider, fetcher, timeoutMs });
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
