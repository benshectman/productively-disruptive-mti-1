import { createHash } from "node:crypto";
import { postEvaluator } from "./evaluator.mjs";
import { normalizeProviderUsage } from "./evaluator-provider.mjs";
import {
  canonicalPairIdentity,
  mapTournamentJudgment,
  mirrorTournamentComparison,
  selectStratifiedDirectComparisons,
  tournamentRequest
} from "./tournament.mjs";

export const DIMENSION_EVALUATOR_MODEL = "qwen/qwen3-235b-a22b-2507";
export const DIMENSION_JUDGMENTS = ["A_stronger", "equivalent", "B_stronger"];

export const EDITORIAL_DIMENSIONS = Object.freeze({
  evidenceSelection: Object.freeze({
    id: "evidenceSelection",
    label: "Evidence Selection",
    sourceCriteria: Object.freeze(["topicRelevance", "selectivity", "evidenceEconomy"]),
    definition: "Assesses whether the response prioritizes the evidence most relevant to the selected topic, chooses the most useful evidence rather than trying to include everything available, and uses that evidence efficiently so each fact earns its place.",
    guardrail: "Judge only this dimension. Do not reward greater fact count or greater length."
  }),
  narrativeSynthesis: Object.freeze({
    id: "narrativeSynthesis",
    label: "Narrative Synthesis",
    sourceCriteria: Object.freeze(["synthesis", "coherence", "nonRepetition", "readability"]),
    definition: "Assesses whether the response combines evidence into a meaningful point of view or narrative rather than presenting disconnected facts, hangs together logically and structurally as a unified piece, avoids unnecessary repetition, and remains clear, fluent, and easy to follow.",
    guardrail: "Judge only this dimension. Do not reward verbosity or surface polish by themselves."
  }),
  claimContributionQuality: Object.freeze({
    id: "claimContributionQuality",
    label: "Claim & Contribution Quality",
    sourceCriteria: Object.freeze(["specificity", "groundedness", "attributionDiscipline"]),
    definition: "Assesses whether claims are concrete and appropriately detailed, remain within the approved evidence without unsupported inference or embellishment, and accurately distinguish Ben's own contribution from team or organizational contributions and outcomes.",
    guardrail: "Existing deterministic validation has already handled mechanically verifiable grounding failures. Focus on meaningful specificity, semantic overreach, attribution accuracy, and clarity about what Ben personally designed, led, enabled, influenced, or helped make possible. Do not re-run mechanical validation."
  })
});

export const DIMENSION_IDS = Object.freeze(Object.keys(EDITORIAL_DIMENSIONS));

export const dimensionJudgmentSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["judgment", "rationale"],
  properties: {
    judgment: { type: "string", enum: DIMENSION_JUDGMENTS },
    rationale: { type: "string", minLength: 1, maxLength: 700 }
  }
});

function stableHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function selectDimensionCalibrationComparisons(cohorts, seed = "dimension-specific-calibration-v1") {
  const stratified = selectStratifiedDirectComparisons(cohorts, `${seed}:candidate-pool`);
  return cohorts.flatMap((cohort) => stratified
    .filter((comparison) => comparison.cohortId === cohort.cohortId)
    .sort((left, right) => stableHash(`${seed}:${canonicalPairIdentity(left)}`)
      .localeCompare(stableHash(`${seed}:${canonicalPairIdentity(right)}`)))
    .slice(0, 2));
}

export function buildDimensionEvaluatorBody(request, dimensionId, model) {
  const dimension = EDITORIAL_DIMENSIONS[dimensionId];
  if (!dimension) throw new Error(`Unknown editorial dimension: ${dimensionId}`);
  return {
    model,
    store: false,
    max_output_tokens: 1200,
    instructions: [
      "You are making one blinded, dimension-specific editorial comparison between two versions of professional portfolio prose created for the same brief, selected topics, and evidence context.",
      "A and B are arbitrary presentation labels. Never infer or speculate which model, system, branch, environment, or generation process produced either response.",
      `Evaluate only ${dimension.label}. ${dimension.definition}`,
      dimension.guardrail,
      "Upstream code has already enforced deterministic evidence eligibility, numeric grounding, project scoping, fallback and reliability status, provenance constraints, and other mechanically verifiable validation. Do not attempt to replace those checks.",
      "The shared evidenceContext contains the evidence pools that were available. Each response's citedEvidence contains the evidence returned with that response. Use them only as needed for the specified editorial dimension.",
      "Return judgment as exactly A_stronger, equivalent, or B_stronger.",
      "Equivalent means there is no meaningful editorial difference between A and B on this specific dimension that would matter to a publication decision. Do not force a winner for trivial or immaterial differences.",
      "Do not evaluate or mention other dimensions. Give a concise rationale naming the dimension-specific distinction that drove the judgment.",
      "Return only the required strict JSON object. Do not include margin or confidence."
    ].join(" "),
    input: JSON.stringify({ dimension: { id: dimension.id, label: dimension.label }, ...request }),
    text: { format: { type: "json_schema", name: `portfolio_${dimension.id}_comparison`, strict: true, schema: dimensionJudgmentSchema } }
  };
}

export function assertDimensionJudgment(value) {
  const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
  if (!value || !DIMENSION_JUDGMENTS.includes(value.judgment)
    || typeof value.rationale !== "string" || !value.rationale.trim()
    || JSON.stringify(keys) !== JSON.stringify(["judgment", "rationale"])) {
    throw new Error("Dimension evaluator response is missing or invalid required fields");
  }
  return value;
}

export function mapDimensionJudgment(comparison, judgment) {
  const mapped = mapTournamentJudgment(comparison, { winner: judgment.judgment });
  return {
    judgment: judgment.judgment,
    rationale: judgment.rationale,
    winnerPosition: mapped.winnerPosition,
    winnerCandidateId: mapped.winnerCandidateId,
    winnerEnvironment: mapped.winnerEnvironment
  };
}

export async function evaluateDimensionOrientation({
  comparison,
  dimensionId,
  runsById,
  apiKey,
  model,
  provider = "openai",
  fetcher = fetch,
  timeoutMs = 60_000,
  maxAttempts = 4,
  retryDelayMs = 0
}) {
  if (!EDITORIAL_DIMENSIONS[dimensionId]) throw new Error(`Unknown editorial dimension: ${dimensionId}`);
  const request = tournamentRequest(comparison, runsById);
  const body = buildDimensionEvaluatorBody(request, dimensionId, model);
  const attempts = [];
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await postEvaluator({ body, apiKey, provider, fetcher, timeoutMs, parse: assertDimensionJudgment });
    attempts.push({ attempt, startedAt: result.startedAt, durationMs: result.durationMs, error: result.error || null });
    if (!result.error) break;
    if (attempt < maxAttempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
  }
  const base = {
    dimensionId,
    comparison: {
      comparisonId: comparison.comparisonId,
      blind: { ...comparison.blind },
      mappedCandidates: structuredClone(comparison.mappedCandidates)
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
    mappedJudgment: mapDimensionJudgment(comparison, result.judgment),
    evaluatorRequest: request,
    rawEvaluatorResponse: result.rawResponse,
    usage: normalizeProviderUsage(result.rawResponse?.usage, provider)
  };
}

function outcomeLabel(candidateId, comparison, strength) {
  const candidate = Object.values(comparison.mappedCandidates).find((item) => item.candidateId === candidateId);
  const prefix = candidate?.environment === "control" || candidate?.environment === "treatment"
    ? candidate.environment
    : candidateId;
  return `${prefix}_${strength}`;
}

export function reconcileDimensionOrientations(comparison, original, mirrored) {
  if (original?.error || mirrored?.error || !original?.mappedJudgment || !mirrored?.mappedJudgment) {
    return { outcome: "failed", directional: false, winnerCandidateId: null, reason: "At least one orientation failed." };
  }
  const first = original.mappedJudgment.winnerCandidateId;
  const second = mirrored.mappedJudgment.winnerCandidateId;
  if (!first && !second) return { outcome: "equivalent", directional: false, winnerCandidateId: null, reason: "Both orientations found no meaningful editorial difference." };
  if (first && second && first !== second) return { outcome: "order_reversal", directional: false, winnerCandidateId: null, reason: "Opposite underlying candidates won across orientations." };
  const winnerCandidateId = first || second;
  const strength = first && second ? "stronger" : "leaning";
  return {
    outcome: outcomeLabel(winnerCandidateId, comparison, strength),
    directional: true,
    winnerCandidateId,
    reason: strength === "stronger"
      ? "The same underlying candidate won in both orientations."
      : "One orientation preferred the candidate and the other found no meaningful difference."
  };
}

export function dimensionEvaluationTasks(comparisons) {
  return comparisons.flatMap((comparison) => DIMENSION_IDS.flatMap((dimensionId) => [
    { comparison, dimensionId, orientation: "original" },
    { comparison: mirrorTournamentComparison(comparison), baseComparison: comparison, dimensionId, orientation: "mirrored" }
  ]));
}
