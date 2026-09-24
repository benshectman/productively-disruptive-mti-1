import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightEvaluator } from "./evaluator.mjs";
import { resolveEvaluatorRuntime } from "./evaluator-provider.mjs";
import { evaluateTournamentBundle } from "./run.mjs";
import { canonicalPairIdentity, createTournamentCohorts } from "./tournament.mjs";

export const OPENROUTER_FULL_TOURNAMENT_MODEL = "qwen/qwen3-235b-a22b-2507";
const PREFLIGHT_MAX_ATTEMPTS = 8;
const PREFLIGHT_RETRY_DELAY_MS = 15_000;
const COMPARISON_MAX_ATTEMPTS = 6;
const COMPARISON_RETRY_DELAY_MS = 5_000;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArgs(argv) {
  const result = { input: null, output: "qwen-full-tournament-results", references: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") result.input = argv[++index];
    else if (argv[index] === "--output") result.output = argv[++index];
    else if (argv[index] === "--reference") {
      const [name, ...filename] = argv[++index].split("=");
      result.references.push({ name, filename: filename.join("=") });
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.input) throw new Error("--input is required");
  return result;
}

function pairType(result) {
  const environments = Object.values(result.comparison.mappedCandidates).map((candidate) => candidate.environment).sort();
  if (environments[0] !== environments[1]) return "controlTreatment";
  return environments[0] === "control" ? "controlControl" : "treatmentTreatment";
}

function stableWinner(result, requireMirror = false) {
  if (!result || result.error || result.mirrorError || result.mirrorAudit?.unstable || result.mirrorAudit?.unresolved) return null;
  if (requireMirror && !result.mirrorAudit) return null;
  return result.mirrorAudit?.winnerCandidateId || result.mappedJudgment?.winnerCandidateId || null;
}

function referenceAgreement(results, reference) {
  const byIdentity = new Map((reference.tournament?.comparisons || []).map((result) => [canonicalPairIdentity(result.comparison), result]));
  const rows = results.map((result) => {
    const identity = canonicalPairIdentity(result.comparison);
    const prior = byIdentity.get(identity);
    return {
      pairIdentity: identity,
      cohortId: result.comparison.cohortId,
      pairType: pairType(result),
      referencePairFound: Boolean(prior),
      qwenWinnerCandidateId: stableWinner(result, true),
      referenceWinnerCandidateId: stableWinner(prior)
    };
  });
  const summarize = (selected) => {
    const comparable = selected.filter((row) => row.qwenWinnerCandidateId && row.referenceWinnerCandidateId);
    const same = comparable.filter((row) => row.qwenWinnerCandidateId === row.referenceWinnerCandidateId).length;
    return {
      canonicalPairsFound: selected.filter((row) => row.referencePairFound).length,
      comparableDirectionalPairs: comparable.length,
      sameDirection: same,
      oppositeDirection: comparable.length - same,
      agreementRate: comparable.length ? same / comparable.length : null
    };
  };
  return {
    evaluatorModel: reference.tournament?.evaluatorModel || reference.metadata?.evaluatorModel || "unknown",
    ...summarize(rows),
    directControlTreatment: summarize(rows.filter((row) => row.pairType === "controlTreatment")),
    outcomes: rows
  };
}

function executionUsage(results, preflight) {
  const records = results.flatMap((result) => [result, result.mirror].filter(Boolean));
  const preflightUsage = preflight?.usage || {};
  return records.reduce((total, record) => {
    const usage = record.usage || record.rawEvaluatorResponse?.usage || {};
    const attempts = Number(record.attemptCount || 1);
    total.apiAttempts += attempts;
    total.retries += Math.max(0, attempts - 1);
    total.successfulJudgments += record.judgment ? 1 : 0;
    total.failedAttempts += (record.attempts || []).filter((attempt) => attempt.error).length;
    total.terminalFailures += record.error ? 1 : 0;
    total.inputTokens += Number(usage.input_tokens || usage.prompt_tokens || 0);
    total.outputTokens += Number(usage.output_tokens || usage.completion_tokens || 0);
    total.totalTokens += Number(usage.total_tokens || 0);
    total.cost += Number(usage.cost || 0);
    total.evaluatorDurationMs += Number(record.durationMs || 0);
    return total;
  }, {
    apiAttempts: Number(preflight?.attemptCount || 0),
    retries: Math.max(0, Number(preflight?.attemptCount || 0) - 1),
    successfulJudgments: 0,
    failedAttempts: Number(preflight?.failedAttempts || 0),
    terminalFailures: 0,
    inputTokens: Number(preflightUsage.input_tokens || preflightUsage.prompt_tokens || 0),
    outputTokens: Number(preflightUsage.output_tokens || preflightUsage.completion_tokens || 0),
    totalTokens: Number(preflightUsage.total_tokens || 0),
    cost: Number(preflightUsage.cost || 0),
    evaluatorDurationMs: Number(preflight?.durationMs || 0)
  });
}

function cohortResults(cohorts, results) {
  return cohorts.map((cohort) => {
    const relevant = results.filter((result) => result.comparison.cohortId === cohort.cohortId);
    const direct = relevant.filter((result) => pairType(result) === "controlTreatment");
    let stableControlWins = 0;
    let stableTreatmentWins = 0;
    for (const result of direct) {
      const winner = stableWinner(result, true);
      if (!winner) continue;
      const candidate = Object.values(result.comparison.mappedCandidates).find((item) => item.candidateId === winner);
      if (candidate?.environment === "control") stableControlWins += 1;
      if (candidate?.environment === "treatment") stableTreatmentWins += 1;
    }
    return {
      cohortId: cohort.cohortId,
      eligiblePairs: relevant.length,
      stablePairs: relevant.filter((result) => stableWinner(result, true)).length,
      unstablePairs: relevant.filter((result) => result.mirrorAudit?.unstable).length,
      unresolvedOrFailedPairs: relevant.filter((result) => !stableWinner(result, true) && !result.mirrorAudit?.unstable).length,
      directPairs: direct.length,
      stableControlWins,
      stableTreatmentWins,
      directInstability: direct.filter((result) => result.mirrorAudit?.unstable).length,
      graph: cohort.graph
    };
  });
}

function percent(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function markdown(summary) {
  const lines = [
    "# Qwen full bidirectional tournament",
    "",
    `Evaluator: \`${summary.evaluatorProvider}\` / \`${summary.evaluatorModel}\``,
    "",
    "Every eligible underlying candidate pair was judged in both A/B orientations. Rankings use only reconciled position-stable edges.",
    "",
    "## Overall",
    "",
    `- Eligible base comparisons: ${summary.eligibleBaseComparisons}`,
    `- Mirrors attempted/completed: ${summary.mirrorsAttempted}/${summary.mirrorsCompleted}`,
    `- Total evaluator judgments: ${summary.totalEvaluatorJudgments}`,
    `- Stable comparisons: ${summary.stableComparisons}`,
    `- Position-unstable comparisons: ${summary.unstableComparisons}`,
    `- Unresolved/failures: ${summary.unresolvedOrFailedComparisons}`,
    `- Mirror-instability rate: ${percent(summary.mirrorInstabilityRate)}`,
    `- Reliability exclusions: ${summary.reliabilityExclusions}`,
    "",
    "## Direct control vs treatment",
    "",
    `- Stable control wins: ${summary.direct.stableControlWins}`,
    `- Stable treatment wins: ${summary.direct.stableTreatmentWins}`,
    `- Position-unstable: ${summary.direct.positionUnstable}`,
    `- Unresolved/failures: ${summary.direct.unresolvedOrFailures}`,
    `- Stable treatment win rate: ${percent(summary.direct.stableTreatmentWinRate)}`,
    "",
    "## Position audit",
    "",
    `- All passes: A ${summary.positionBias.allPasses.A}, B ${summary.positionBias.allPasses.B}, unclear ${summary.positionBias.allPasses.unclear}`,
    `- Base pass: A ${summary.positionBias.originalPasses.A}, B ${summary.positionBias.originalPasses.B}, unclear ${summary.positionBias.originalPasses.unclear}`,
    `- Mirror pass: A ${summary.positionBias.mirroredPasses.A}, B ${summary.positionBias.mirroredPasses.B}, unclear ${summary.positionBias.mirroredPasses.unclear}`,
    `- Control vs treatment instability: ${summary.stabilityByType.controlTreatment.unstable}/${summary.stabilityByType.controlTreatment.total}`,
    `- Control vs control instability: ${summary.stabilityByType.controlControl.unstable}/${summary.stabilityByType.controlControl.total}`,
    `- Treatment vs treatment instability: ${summary.stabilityByType.treatmentTreatment.unstable}/${summary.stabilityByType.treatmentTreatment.total}`,
    "",
    "## Judgment distributions across both passes",
    "",
    `- Margins: ${JSON.stringify(summary.margins)}`,
    `- Confidence: ${JSON.stringify(summary.confidence)}`,
    "",
    "## Cohorts",
    "",
    "| Cohort | Stable/all | Unstable | Direct control | Direct treatment | Direct unstable | Graph |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.cohorts.map((cohort) => `| ${cohort.cohortId} | ${cohort.stablePairs}/${cohort.eligiblePairs} | ${cohort.unstablePairs} | ${cohort.stableControlWins} | ${cohort.stableTreatmentWins} | ${cohort.directInstability} | ${cohort.graph.orderingStrength}; ${cohort.graph.connectedComponents} component(s) |`),
    "",
    "## Exact canonical-pair agreement",
    "",
    "| Reference | Model | Found | Comparable | Same | Opposite | Agreement | Direct C/T comparable | Direct C/T agreement |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(summary.referenceAgreement).map(([name, item]) => `| ${name} | ${item.evaluatorModel} | ${item.canonicalPairsFound} | ${item.comparableDirectionalPairs} | ${item.sameDirection} | ${item.oppositeDirection} | ${percent(item.agreementRate)} | ${item.directControlTreatment.comparableDirectionalPairs} | ${percent(item.directControlTreatment.agreementRate)} |`),
    "",
    "## API execution",
    "",
    `- Attempts: ${summary.execution.apiAttempts}`,
    `- Retries / failed attempts: ${summary.execution.retries} / ${summary.execution.failedAttempts}`,
    `- Successful judgments / terminal failures: ${summary.execution.successfulJudgments} / ${summary.execution.terminalFailures}`,
    `- Tokens: input ${summary.execution.inputTokens}, output ${summary.execution.outputTokens}, total ${summary.execution.totalTokens}`,
    `- Reported OpenRouter cost: $${summary.execution.cost.toFixed(6)}`,
    `- Runtime: ${(summary.runtimeMs / 1000).toFixed(1)} seconds`,
    "",
    `## Conclusion`,
    "",
    summary.conclusion,
    "",
    "Ben remains the final editorial judge."
  ];
  return `${lines.join("\n")}\n`;
}

export function summarizeFullTournament({ bundle, references, preflight, startedAt, completedAt }) {
  const results = bundle.tournament.comparisons;
  const summary = bundle.tournament.summary;
  const stableComparisons = results.filter((result) => stableWinner(result, true)).length;
  const unstableComparisons = results.filter((result) => result.mirrorAudit?.unstable).length;
  const direct = results.filter((result) => pairType(result) === "controlTreatment");
  const referenceAgreementResults = Object.fromEntries(Object.entries(references).map(([name, reference]) => [name, referenceAgreement(results, reference)]));
  const lunaSol = [referenceAgreementResults.luna?.agreementRate, referenceAgreementResults.sol?.agreementRate].filter((value) => value != null);
  const lunaSolRate = lunaSol.length ? lunaSol.reduce((sum, value) => sum + value, 0) / lunaSol.length : null;
  const miniRate = referenceAgreementResults.mini?.agreementRate ?? null;
  const alignment = lunaSolRate != null && lunaSolRate >= 0.6 && (miniRate == null || lunaSolRate >= miniRate + 0.05)
    ? "Luna/Sol"
    : miniRate != null && miniRate >= 0.6 && (lunaSolRate == null || miniRate >= lunaSolRate + 0.05)
      ? "Mini"
      : "neither";
  const stableDirectTotal = summary.directWins.control + summary.directWins.treatment;
  return {
    evaluatorProvider: "openrouter",
    evaluatorModel: OPENROUTER_FULL_TOURNAMENT_MODEL,
    eligibleBaseComparisons: results.length,
    mirrorsAttempted: results.filter((result) => result.mirror || result.mirrorError).length,
    mirrorsCompleted: results.filter((result) => result.mirror?.judgment).length,
    totalEvaluatorJudgments: results.filter((result) => result.judgment).length + results.filter((result) => result.mirror?.judgment).length,
    stableComparisons,
    unstableComparisons,
    unresolvedOrFailedComparisons: results.length - stableComparisons - unstableComparisons,
    mirrorInstabilityRate: results.length ? unstableComparisons / results.length : null,
    reliabilityExclusions: bundle.tournament.cohorts.reduce((sum, cohort) => sum + cohort.excludedCandidates.length, 0),
    direct: {
      eligiblePairs: direct.length,
      stableControlWins: summary.directWins.control,
      stableTreatmentWins: summary.directWins.treatment,
      positionUnstable: direct.filter((result) => result.mirrorAudit?.unstable).length,
      unresolvedOrFailures: direct.filter((result) => !stableWinner(result, true) && !result.mirrorAudit?.unstable).length,
      stableTreatmentWinRate: stableDirectTotal ? summary.directWins.treatment / stableDirectTotal : null
    },
    positionBias: summary.positionBias,
    stabilityByType: summary.stabilityByType,
    margins: summary.allPassMargins,
    confidence: summary.allPassConfidence,
    cohorts: cohortResults(bundle.tournament.cohorts, results),
    referenceAgreement: referenceAgreementResults,
    execution: executionUsage(results, preflight),
    startedAt,
    completedAt,
    runtimeMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    alignment,
    conclusion: `On position-stable canonical pairs, Qwen aligns most closely with ${alignment}. Position instability is expected evaluator behavior and is excluded from directional evidence.`
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const source = JSON.parse(await readFile(options.input, "utf8"));
  if ((source.runs || []).length !== 66) throw new Error(`Expected the stored 66-response corpus; found ${(source.runs || []).length}`);
  const runtime = resolveEvaluatorRuntime({
    config: { defaultProvider: "openrouter", apiKeyEnvByProvider: { openrouter: "OPENROUTER_API_KEY" }, defaultModel: OPENROUTER_FULL_TOURNAMENT_MODEL }
  });
  if (runtime.provider !== "openrouter" || runtime.model !== OPENROUTER_FULL_TOURNAMENT_MODEL) throw new Error("Full tournament provider/model must remain explicitly pinned");
  const config = structuredClone(source.config);
  config.tournament = {
    ...config.tournament,
    mirrorEvery: true,
    maxAttempts: COMPARISON_MAX_ATTEMPTS,
    retryDelayMs: COMPARISON_RETRY_DELAY_MS
  };
  const cohorts = createTournamentCohorts(source.runs, config.tournament.pairingSeed);
  if (cohorts.length !== 11) throw new Error(`Expected 11 cohorts; found ${cohorts.length}`);
  const eligibleComparisonCount = cohorts.reduce((sum, cohort) => sum + cohort.comparisons.length, 0);
  if (eligibleComparisonCount !== 160) throw new Error(`Expected 160 eligible base comparisons; found ${eligibleComparisonCount}`);
  await mkdir(options.output, { recursive: true });
  const checkpointPath = path.join(options.output, "qwen-full-tournament.json");
  let bundle;
  try {
    bundle = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    bundle = {
      ...structuredClone(source),
      config,
      metadata: { ...source.metadata, validationMode: "full-bidirectional-qwen-tournament" },
      tournament: { schemaVersion: 1, cohorts, comparisons: [], summary: null, humanReviewShortlist: [] }
    };
  }
  let preflight;
  let preflightFailures = 0;
  for (let attempt = 1; attempt <= PREFLIGHT_MAX_ATTEMPTS; attempt += 1) {
    try {
      preflight = await preflightEvaluator({ ...runtime, timeoutMs: 120_000 });
      preflight = { ...preflight, attemptCount: attempt, failedAttempts: preflightFailures, success: true };
      break;
    } catch (error) {
      preflightFailures += 1;
      if (attempt === PREFLIGHT_MAX_ATTEMPTS) throw error;
      await delay(PREFLIGHT_RETRY_DELAY_MS * attempt);
    }
  }
  await evaluateTournamentBundle({
    bundle,
    config,
    ...runtime,
    persist: async (current) => writeFile(checkpointPath, `${JSON.stringify(current, null, 2)}\n`, "utf8")
  });
  const references = Object.fromEntries(await Promise.all(options.references.map(async ({ name, filename }) => [name, JSON.parse(await readFile(filename, "utf8"))])));
  const completedAt = new Date().toISOString();
  const validation = summarizeFullTournament({ bundle, references, preflight, startedAt, completedAt });
  bundle.fullTournamentValidation = validation;
  bundle.metadata.evaluatorPreflight = preflight;
  await writeFile(checkpointPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(path.join(options.output, "qwen-full-tournament.md"), markdown(validation), "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
