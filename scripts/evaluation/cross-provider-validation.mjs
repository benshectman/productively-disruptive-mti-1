import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTournamentComparison, preflightEvaluator } from "./evaluator.mjs";
import { resolveEvaluatorRuntime } from "./evaluator-provider.mjs";
import {
  createTournamentCohorts,
  mirrorTournamentComparison,
  reconcileTournamentMirror,
  selectStratifiedDirectComparisons
} from "./tournament.mjs";

export const OPENROUTER_VALIDATION_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const REQUEST_BUDGET = 50;
const MAX_MIRRORS = 8;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArgs(argv) {
  const result = { input: null, output: "validation-results", references: [] };
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

function resultDirection(result) {
  if (!result || result.error) return "failure";
  return result.mappedJudgment?.winnerEnvironment || "unclear";
}

function usage(results, preflightAttempts = 1, preflightSuccesses = 1, preflightFailures = 0) {
  const records = results.flatMap((result) => [result, result.mirror].filter(Boolean));
  return records.reduce((total, result) => {
    total.attempts += Number(result.attemptCount || 1);
    total.successes += result.judgment ? 1 : 0;
    total.failedAttempts += (result.attempts || []).filter((attempt) => attempt.error).length;
    total.terminalFailures += result.error ? 1 : 0;
    total.inputTokens += Number(result.usage?.input_tokens || 0);
    total.outputTokens += Number(result.usage?.output_tokens || 0);
    total.totalTokens += Number(result.usage?.total_tokens || 0);
    total.durationMs += Number(result.durationMs || 0);
    return total;
  }, { attempts: preflightAttempts, successes: preflightSuccesses, failedAttempts: preflightFailures, terminalFailures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 });
}

function counts(values, allowed) {
  return Object.fromEntries(allowed.map((value) => [value, values.filter((item) => item === value).length]));
}

function referenceComparison(sampled, reference) {
  const byId = new Map((reference.tournament?.comparisons || []).map((result) => [result.comparison?.comparisonId, result]));
  const outcomes = sampled.map((result) => {
    const prior = byId.get(result.comparison.comparisonId);
    return {
      comparisonId: result.comparison.comparisonId,
      cohortId: result.comparison.cohortId,
      nemotron: resultDirection(result),
      reference: resultDirection(prior)
    };
  });
  const comparable = outcomes.filter((outcome) => !["failure", "unclear"].includes(outcome.nemotron)
    && !["failure", "unclear"].includes(outcome.reference));
  const same = comparable.filter((outcome) => outcome.nemotron === outcome.reference).length;
  return {
    evaluatorModel: reference.tournament?.evaluatorModel || reference.metadata?.evaluatorModel || "unknown",
    sampledPairsFound: outcomes.filter((outcome) => outcome.reference !== "failure").length,
    comparablePairs: comparable.length,
    sameDirection: same,
    oppositeDirection: comparable.length - same,
    agreementRate: comparable.length ? same / comparable.length : null,
    outcomes
  };
}

export function summarizeValidation({ comparisons, references = {}, startedAt, completedAt, preflight, sample }) {
  const baseDirections = comparisons.map(resultDirection);
  const successful = comparisons.filter((result) => !result.error);
  const margins = successful.map((result) => result.judgment.margin);
  const confidences = successful.map((result) => result.judgment.confidence);
  const cohorts = [...new Set(comparisons.map((result) => result.comparison.cohortId))].map((cohortId) => {
    const results = comparisons.filter((result) => result.comparison.cohortId === cohortId);
    const directions = results.map(resultDirection);
    const cohortCounts = counts(directions, ["control", "treatment", "unclear", "failure"]);
    return { cohortId, ...cohortCounts, direction: cohortCounts.treatment > cohortCounts.control ? "treatment" : cohortCounts.control > cohortCounts.treatment ? "control" : "mixed" };
  });
  const referenceAgreement = Object.fromEntries(Object.entries(references).map(([name, reference]) => [name, referenceComparison(comparisons, reference)]));
  const lunaSolRates = [referenceAgreement.luna?.agreementRate, referenceAgreement.sol?.agreementRate].filter((value) => value != null);
  const lunaSolAgreement = lunaSolRates.length ? lunaSolRates.reduce((sum, value) => sum + value, 0) / lunaSolRates.length : null;
  const miniAgreement = referenceAgreement.mini?.agreementRate ?? null;
  const agreementConclusion = lunaSolAgreement != null && lunaSolAgreement >= 0.6 && (miniAgreement == null || lunaSolAgreement >= miniAgreement + 0.05)
    ? "luna-sol"
    : miniAgreement != null && miniAgreement >= 0.6 && (lunaSolAgreement == null || miniAgreement >= lunaSolAgreement + 0.05)
      ? "mini"
      : "neither";
  const mirrors = comparisons.filter((result) => result.mirror);
  const api = usage(comparisons, preflight?.attemptCount || 0, preflight?.success ? 1 : 0, preflight?.failedAttempts || 0);
  const treatmentAsA = sample.filter((comparison) => comparison.mappedCandidates.A.environment === "treatment").length;
  const repetitions = Object.fromEntries([1, 2, 3].map((repetition) => [repetition, {
    control: sample.filter((comparison) => Object.values(comparison.mappedCandidates).some((candidate) => candidate.environment === "control" && candidate.repetition === repetition)).length,
    treatment: sample.filter((comparison) => Object.values(comparison.mappedCandidates).some((candidate) => candidate.environment === "treatment" && candidate.repetition === repetition)).length
  }]));
  return {
    schemaVersion: 1,
    metadata: {
      startedAt,
      completedAt,
      runtimeMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      evaluatorProvider: "openrouter",
      evaluatorModel: OPENROUTER_VALIDATION_MODEL,
      purpose: "sparse cross-provider validation; no Bradley-Terry ranking"
    },
    sample: { baseComparisons: sample.length, cohorts: cohorts.length, treatmentAsA, controlAsA: sample.length - treatmentAsA, repetitions },
    outcomes: counts(baseDirections, ["control", "treatment", "unclear", "failure"]),
    margins: counts(margins, ["slight", "clear", "substantial"]),
    confidence: counts(confidences, ["low", "medium", "high"]),
    mirrorAudit: {
      mirroredComparisons: mirrors.length,
      stable: mirrors.filter((result) => result.mirrorAudit && !result.mirrorAudit.unstable && !result.mirrorAudit.unresolved).length,
      reversals: mirrors.filter((result) => result.mirrorAudit?.unstable).length,
      unresolved: mirrors.filter((result) => result.mirrorAudit?.unresolved).length,
      failures: mirrors.filter((result) => result.mirrorError).length
    },
    cohorts,
    api,
    preflight,
    referenceAgreement,
    conclusion: { agreement: agreementConclusion, lunaSolAgreement, miniAgreement, finalEditorialJudge: "Ben" },
    comparisons
  };
}

function percent(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function markdown(summary) {
  const lines = [
    "# Nemotron sparse cross-provider validation",
    "",
    `Model: \`${summary.metadata.evaluatorModel}\` via OpenRouter`,
    "",
    "This is a 33-pair stratified direct control-vs-treatment validation. It does not fit or report a six-way Bradley-Terry ranking.",
    "",
    "## Overall",
    "",
    `- Treatment wins: ${summary.outcomes.treatment}`,
    `- Control wins: ${summary.outcomes.control}`,
    `- Unclear: ${summary.outcomes.unclear}`,
    `- Terminal failures: ${summary.outcomes.failure}`,
    `- Margins: slight ${summary.margins.slight}, clear ${summary.margins.clear}, substantial ${summary.margins.substantial}`,
    `- Confidence: low ${summary.confidence.low}, medium ${summary.confidence.medium}, high ${summary.confidence.high}`,
    `- A/B placement: treatment as A ${summary.sample.treatmentAsA}, control as A ${summary.sample.controlAsA}`,
    "",
    "## Mirrored checks",
    "",
    `- Mirrored comparisons: ${summary.mirrorAudit.mirroredComparisons}`,
    `- Stable: ${summary.mirrorAudit.stable}`,
    `- Reversals / position instability: ${summary.mirrorAudit.reversals}`,
    `- Unresolved: ${summary.mirrorAudit.unresolved}`,
    `- Mirror failures: ${summary.mirrorAudit.failures}`,
    "",
    "## API execution",
    "",
    `- Attempts (including preflight): ${summary.api.attempts}`,
    `- Successful calls (including preflight): ${summary.api.successes}`,
    `- Failed attempts: ${summary.api.failedAttempts}`,
    `- Terminal comparison failures: ${summary.api.terminalFailures}`,
    `- Tokens: input ${summary.api.inputTokens}, output ${summary.api.outputTokens}, total ${summary.api.totalTokens}`,
    `- Runtime: ${(summary.metadata.runtimeMs / 1000).toFixed(1)} seconds`,
    "",
    "## Cohort direction",
    "",
    "| Cohort | Treatment | Control | Unclear | Failure | Direction |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...summary.cohorts.map((cohort) => `| ${cohort.cohortId} | ${cohort.treatment} | ${cohort.control} | ${cohort.unclear} | ${cohort.failure} | ${cohort.direction} |`),
    "",
    "## Exact sampled-pair agreement with prior evaluators",
    "",
    "| Reference | Model | Comparable | Same direction | Opposite | Agreement |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...Object.entries(summary.referenceAgreement).map(([name, result]) => `| ${name} | ${result.evaluatorModel} | ${result.comparablePairs} | ${result.sameDirection} | ${result.oppositeDirection} | ${percent(result.agreementRate)} |`),
    "",
    "## Conclusion",
    "",
    summary.conclusion.agreement === "luna-sol"
      ? "On the exact sampled pairs, Nemotron broadly agrees more with Luna/Sol than with Mini."
      : summary.conclusion.agreement === "mini"
        ? "On the exact sampled pairs, Nemotron broadly agrees more with Mini than with Luna/Sol."
        : "On the exact sampled pairs, Nemotron does not show a sufficiently distinct broad agreement with Luna/Sol or Mini.",
    "",
    "Ben remains the final editorial judge. Full per-pair mappings, rationales, attempts, usage, mirror audits, and exact reference outcomes are preserved in the JSON artifact."
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const source = JSON.parse(await readFile(options.input, "utf8"));
  if ((source.runs || []).length !== 66) throw new Error(`Expected the stored 66-response corpus; found ${(source.runs || []).length}`);
  const runtime = resolveEvaluatorRuntime({
    config: { defaultProvider: "openrouter", apiKeyEnvByProvider: { openrouter: "OPENROUTER_API_KEY" }, defaultModel: OPENROUTER_VALIDATION_MODEL }
  });
  if (runtime.provider !== "openrouter" || runtime.model !== OPENROUTER_VALIDATION_MODEL) throw new Error("Nemotron validation provider/model must remain pinned");
  const cohorts = createTournamentCohorts(source.runs, source.config?.tournament?.pairingSeed || "portfolio-generation-tournament-v1");
  if (cohorts.length !== 11) throw new Error(`Expected 11 topic cohorts; found ${cohorts.length}`);
  const sample = selectStratifiedDirectComparisons(cohorts);
  if (sample.length !== 33) throw new Error(`Expected 33 sampled comparisons; found ${sample.length}`);
  const references = Object.fromEntries(await Promise.all(options.references.map(async ({ name, filename }) => [name, JSON.parse(await readFile(filename, "utf8"))])));
  const runsById = new Map(source.runs.map((run) => [run.runId, run]));
  await mkdir(options.output, { recursive: true });
  const checkpointPath = path.join(options.output, "nemotron-validation.json");
  let preflight;
  let preflightFailures = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      preflight = await preflightEvaluator({ ...runtime, timeoutMs: 120_000 });
      preflight = { ...preflight, attemptCount: attempt, failedAttempts: preflightFailures, success: true };
      break;
    } catch (error) {
      preflightFailures += 1;
      if (attempt === 2) throw error;
      await delay(1_000);
    }
  }
  let comparisons = [];
  const persist = async () => writeFile(checkpointPath, `${JSON.stringify({ startedAt, preflight, sample, comparisons }, null, 2)}\n`, "utf8");
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (Array.isArray(checkpoint.comparisons)) comparisons = checkpoint.comparisons;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (let index = 0; index < sample.length; index += 1) {
    const existingIndex = comparisons.findIndex((result) => result.comparison?.comparisonId === sample[index].comparisonId);
    if (existingIndex >= 0 && !comparisons[existingIndex].error) continue;
    console.log(`[nemotron ${index + 1}/${sample.length}] ${sample[index].cohortId} ${sample[index].comparisonId}`);
    const evaluated = await evaluateTournamentComparison({ comparison: sample[index], runsById, ...runtime, timeoutMs: 120_000 });
    if (existingIndex >= 0) comparisons[existingIndex] = evaluated;
    else comparisons.push(evaluated);
    await persist();
    await delay(1_000);
  }
  comparisons.sort((left, right) => sample.findIndex((comparison) => comparison.comparisonId === left.comparison?.comparisonId)
    - sample.findIndex((comparison) => comparison.comparisonId === right.comparison?.comparisonId));
  const uncertain = comparisons.filter((result) => !result.error && !result.mirror && (result.judgment.margin === "slight" || result.judgment.confidence === "low"));
  const baseUsage = usage(comparisons, preflight.attemptCount, 1, preflight.failedAttempts);
  const mirrorLimit = Math.min(MAX_MIRRORS, Math.floor(Math.max(0, REQUEST_BUDGET - baseUsage.attempts) / 2), uncertain.length);
  for (const result of uncertain.slice(0, mirrorLimit)) {
    console.log(`[nemotron mirror] ${result.comparison.cohortId} ${result.comparison.comparisonId}`);
    const mirror = await evaluateTournamentComparison({ comparison: mirrorTournamentComparison(result.comparison), runsById, ...runtime, timeoutMs: 120_000 });
    result.mirror = mirror;
    if (mirror.error) result.mirrorError = mirror.error;
    else result.mirrorAudit = reconcileTournamentMirror(result, mirror);
    await persist();
    await delay(1_000);
  }
  const completedAt = new Date().toISOString();
  const summary = summarizeValidation({ comparisons, references, startedAt, completedAt, preflight, sample });
  await writeFile(checkpointPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(options.output, "nemotron-validation.md"), markdown(summary), "utf8");
  console.log(markdown(summary));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
