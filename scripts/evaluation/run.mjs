import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSESSMENT_EXCEPTIONS,
  ASSESSMENT_RATINGS,
  aggregateQualitative,
  chooseShortlist,
  CRITERIA,
  mirrorPair,
  reconcileMirroredArbitrations,
  sanityAssessment,
  validateConfig
} from "./core.mjs";
import { generateCorpus } from "./corpus.mjs";
import { evaluateArbitration, evaluatePair, evaluateTournamentComparison, preflightEvaluator } from "./evaluator.mjs";
import { resolveEvaluatorRuntime } from "./evaluator-provider.mjs";
import { buildMarkdownReport } from "./report.mjs";
import {
  aggregateTournament,
  createTournamentCohorts,
  mirrorTournamentComparison,
  reconcileTournamentMirror,
  shouldMirrorTournamentResult,
  tournamentHumanReviewShortlist
} from "./tournament.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export function args(argv) {
  const result = { config: path.join(scriptDirectory, "default-config.json"), output: "evaluation-results", input: null, captureOnly: false, reportOnly: false, sanity: false, tournament: true, fullTournament: false, tournamentOnly: false, tournamentCohorts: null, mirrorComparisonIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") result.config = argv[++index];
    else if (value === "--output") result.output = argv[++index];
    else if (value === "--input") result.input = argv[++index];
    else if (value === "--evaluate-existing") result.input = argv[++index];
    else if (value === "--capture-only") result.captureOnly = true;
    else if (value === "--report-only") result.reportOnly = true;
    else if (value === "--sanity") result.sanity = true;
    else if (value === "--no-tournament") result.tournament = false;
    else if (value === "--full-tournament") result.fullTournament = true;
    else if (value === "--tournament-only") { result.tournament = true; result.tournamentOnly = true; }
    else if (value === "--tournament-cohorts") result.tournamentCohorts = Number.parseInt(argv[++index], 10);
    else if (value === "--mirror-comparison") result.mirrorComparisonIds.push(argv[++index]);
    else if (value === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function help() {
  return `Portfolio generation evaluation harness

Usage:
  npm run eval:harness -- [--config FILE] [--output DIR] [--capture-only] [--sanity]
  npm run eval:harness -- --evaluate-existing CAPTURE.json [--output DIR]
  npm run eval:harness -- --evaluate-existing CAPTURE.json --tournament-only [--tournament-cohorts 3]
  npm run eval:harness -- --input CAPTURE.json [--output DIR]  # backward-compatible alias
  npm run eval:report -- --input RESULTS.json [--output DIR]

Required for capture:
  EVAL_CONTROL_URL       Branch deploy or Deploy Preview base URL
  EVAL_TREATMENT_URL     Branch deploy or Deploy Preview base URL

Required for qualitative evaluation:
  The API key selected by EVAL_PROVIDER (never written to output)

Optional:
  EVAL_CONTROL_ID, EVAL_TREATMENT_ID, EVAL_MODEL, TOURNAMENT_EVAL_MODEL

The combined command runs an evaluator preflight before capture, writes an atomic capture checkpoint before qualitative evaluation, and saves evaluator progress after every pair.

Use --sanity with equivalent endpoints to add the control-vs-control audit. Only unresolved pairs receive blinded arbitration, and sanity mode mirrors those arbitration placements.
The tournament runs by default. Use --full-tournament to mirror every eligible comparison with expanded retry handling, --no-tournament to omit it, or --tournament-only to evaluate a saved corpus without rerunning independent assessment.`;
}
const delay = (milliseconds) => milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();

export function applyRuntimeMode(config, options = {}) {
  if (!options.fullTournament) return config;
  return {
    ...config,
    evaluator: {
      ...config.evaluator,
      preflightMaxAttempts: 8,
      preflightRetryDelayMs: 15_000,
      preflightTimeoutMs: 120_000
    },
    tournament: {
      ...config.tournament,
      enabled: true,
      mirrorEvery: true,
      maxAttempts: 6,
      retryDelayMs: 5_000
    }
  };
}

export async function preflightWithRetry(runtime, config = {}, preflight = preflightEvaluator) {
  const maxAttempts = Math.max(1, config.preflightMaxAttempts || 1);
  const retryDelayMs = Math.max(0, config.preflightRetryDelayMs || 0);
  let failedAttempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await preflight({ ...runtime, timeoutMs: config.preflightTimeoutMs });
      return { ...result, attemptCount: attempt, failedAttempts };
    } catch (error) {
      failedAttempts += 1;
      if (attempt === maxAttempts) throw error;
      await delay(retryDelayMs * attempt);
    }
  }
}
async function mapWithConcurrency(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let next = 0;
  async function consume() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await worker(tasks[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, consume));
  return results;
}

async function loadJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

async function writeBundle(bundle, outputDirectory, stem) {
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, `${stem}.json`);
  const markdownPath = path.join(outputDirectory, `${stem}.md`);
  await writeFile(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, buildMarkdownReport(bundle), "utf8");
  return { jsonPath, markdownPath };
}

export async function writeJsonAtomic(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporaryPath = `${filename}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filename);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function evaluationForPair(bundle, pairId) {
  return (bundle.evaluations || []).find((evaluation) => evaluation.pair?.pairId === pairId);
}

function hasIndependentAssessments(evaluation) {
  return ["control", "treatment"].every((environment) => {
    const assessment = evaluation?.independentAssessments?.[environment]?.assessment;
    return Boolean(
      assessment
      && ASSESSMENT_RATINGS.includes(assessment.overall?.rating)
      && ASSESSMENT_EXCEPTIONS.includes(assessment.overall?.exception)
      && ["high", "medium", "low"].includes(assessment.overall?.confidence)
      && ["high", "medium", "low"].includes(assessment.confidence)
      && CRITERIA.every((criterion) => {
        const item = assessment.criteria?.[criterion];
        return item
          && ASSESSMENT_RATINGS.includes(item.rating)
          && ASSESSMENT_EXCEPTIONS.includes(item.exception)
          && ["high", "medium", "low"].includes(item.confidence);
      })
    );
  });
}

function upsertEvaluation(bundle, pairId, evaluation) {
  bundle.evaluations ||= [];
  const index = bundle.evaluations.findIndex((item) => item.pair?.pairId === pairId);
  if (index === -1) bundle.evaluations.push(evaluation);
  else bundle.evaluations[index] = evaluation;
}

export function needsQualitativeEvaluation(bundle, sanityMode = bundle.metadata?.mode === "sanity") {
  return (bundle.pairs || []).some((pair) => {
    const evaluation = evaluationForPair(bundle, pair.pairId);
    if (!evaluation || evaluation.error || evaluation.mirrorError) return true;
    if (pair.eligibility && !pair.eligibility.qualitativeEligible) return false;
    if (!hasIndependentAssessments(evaluation)) return true;
    if (evaluation.arbitrationRequired && !evaluation.arbitration) return true;
    return sanityMode && evaluation.arbitrationRequired && !evaluation.mirrorAudit && !evaluation.mirrorError;
  });
}

function evaluationComplete(evaluation, pair, sanityMode) {
  if (!evaluation || evaluation.error) return false;
  if (pair.eligibility && !pair.eligibility.qualitativeEligible) return true;
  if (!hasIndependentAssessments(evaluation)) return false;
  if (evaluation.arbitrationRequired && !evaluation.arbitration) return false;
  return !(sanityMode && evaluation.arbitrationRequired && !evaluation.mirrorAudit && !evaluation.mirrorError);
}

function finalClassification(environmentResult) {
  if (environmentResult === "control") return "control_stronger";
  if (environmentResult === "treatment") return "treatment_stronger";
  if (environmentResult === "unresolved") return "unresolved";
  return "equivalent";
}

function finalCriteria(unblinded) {
  return Object.fromEntries(Object.entries(unblinded.criteria || {}).map(([criterion, item]) => [criterion, {
    environmentResult: item.environmentResult,
    judgment: item.judgment,
    controlException: item.controlException,
    treatmentException: item.treatmentException,
    rationale: item.rationale
  }]));
}

export async function evaluateBundle({ bundle, config, apiKey, model, provider = "openai", sanityMode, evaluator = evaluatePair, arbitrator = evaluateArbitration, persist = async () => {} }) {
  const runsById = new Map(bundle.runs.map((run) => [run.runId, run]));
  for (let index = 0; index < bundle.pairs.length; index += 1) {
    const pair = bundle.pairs[index];
    const existing = evaluationForPair(bundle, pair.pairId);
    if (evaluationComplete(existing, pair, false)) continue;
    console.log(`[evaluator ${index + 1}/${bundle.pairs.length}] ${pair.pairId} independent assessment`);
    const evaluation = await evaluator({ pair, runsById, apiKey, model, provider });
    if (!pair.eligibility && evaluation.pair?.eligibility) pair.eligibility = evaluation.pair.eligibility;
    upsertEvaluation(bundle, pair.pairId, evaluation);
    await persist(bundle);
    await delay(config.requestDelayMs || 0);
  }
  if (sanityMode) {
    for (let index = 0; index < bundle.pairs.length; index += 1) {
      const pair = bundle.pairs[index];
      const existing = evaluationForPair(bundle, pair.pairId);
      if (!existing || existing.error || !existing.arbitrationRequired || !existing.arbitration || existing.mirrorAudit || existing.mirrorError) continue;
      console.log(`[evaluator ${index + 1}/${bundle.pairs.length}] ${pair.pairId} mirrored arbitration`);
      const mirrored = await arbitrator({ pair: mirrorPair(pair), runsById, apiKey, model, provider });
      if (mirrored.error) {
        upsertEvaluation(bundle, pair.pairId, { ...existing, mirrorError: mirrored.error, failedMirrorPass: mirrored });
      } else {
        const reconciled = reconcileMirroredArbitrations(existing.arbitration, mirrored);
        const independentConcerns = (existing.unblinded?.concerns || []).filter((concern) => concern.response);
        const unblinded = {
          ...reconciled.unblinded,
          concerns: [...independentConcerns, ...reconciled.unblinded.concerns]
        };
        upsertEvaluation(bundle, pair.pairId, {
          ...existing,
          arbitrationMirror: mirrored,
          mirrorAudit: reconciled.mirrorAudit,
          final: {
            source: "mirrored-arbitration",
            classification: finalClassification(unblinded.overall.environmentResult),
            confidence: reconciled.judgment.confidence,
            rationale: reconciled.judgment.overall.rationale,
            criteria: finalCriteria(unblinded)
          },
          unblinded
        });
      }
      await persist(bundle);
      await delay(config.requestDelayMs || 0);
    }
  }
  const order = new Map(bundle.pairs.map((pair, index) => [pair.pairId, index]));
  bundle.evaluations.sort((left, right) => (order.get(left.pair?.pairId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.pair?.pairId) ?? Number.MAX_SAFE_INTEGER));
  bundle.metadata.evaluationFlow = "independent-assessment -> deterministic-comparison -> unresolved-only-blinded-arbitration";
  bundle.metadata.independentAssessmentsPerEligiblePair = 2;
  bundle.metadata.mirroredArbitrationPasses = sanityMode ? "unresolved-pairs-only" : "not-run";
  return bundle;
}

function tournamentResultFor(bundle, comparisonId) {
  return (bundle.tournament?.comparisons || []).find((result) => result.comparison?.comparisonId === comparisonId);
}

export function needsTournamentEvaluation(bundle, cohorts) {
  return cohorts.some((cohort) => cohort.comparisons.some((comparison) => {
    const result = tournamentResultFor(bundle, comparison.comparisonId);
    return !result || Boolean(result.error) || Boolean(result.mirrorError);
  }));
}

function sumTournamentUsage(results) {
  return results.reduce((total, result) => {
    const records = [result, result.mirror].filter(Boolean);
    for (const record of records) {
      const usage = record.usage || record.rawEvaluatorResponse?.usage || {};
      total.inputTokens += Number(usage.input_tokens || 0);
      total.outputTokens += Number(usage.output_tokens || 0);
      total.totalTokens += Number(usage.total_tokens || 0);
      total.calls += Number(record.attemptCount || 1);
      total.successfulCalls += record.judgment ? 1 : 0;
      total.failedAttempts += (record.attempts || []).filter((attempt) => attempt.error).length;
      total.durationMs += Number(record.durationMs || 0);
    }
    return total;
  }, { calls: 0, successfulCalls: 0, failedAttempts: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 });
}

export async function evaluateTournamentBundle({
  bundle,
  config,
  apiKey,
  model,
  provider = "openai",
  cohortLimit = null,
  explicitMirrorIds = [],
  evaluator = evaluateTournamentComparison,
  persist = async () => {}
}) {
  const allCohorts = createTournamentCohorts(bundle.runs || [], config.tournament?.pairingSeed || `${config.pairingSeed}:tournament`);
  const cohorts = Number.isInteger(cohortLimit) && cohortLimit > 0 ? allCohorts.slice(0, cohortLimit) : allCohorts;
  bundle.tournament ||= { schemaVersion: 1, cohorts, comparisons: [], summary: null, humanReviewShortlist: [] };
  bundle.tournament.cohorts = cohorts;
  bundle.tournament.evaluatorModel = model;
  bundle.tournament.comparisons ||= [];
  const runsById = new Map((bundle.runs || []).map((run) => [run.runId, run]));
  const comparisons = cohorts.flatMap((cohort) => cohort.comparisons);
  const comparisonOrder = new Map(comparisons.map((comparison, index) => [comparison.comparisonId, index]));
  let persistChain = Promise.resolve();
  const checkpoint = () => {
    const snapshot = structuredClone(bundle);
    persistChain = persistChain.then(() => persist(snapshot));
    return persistChain;
  };
  const concurrency = Math.max(1, config.tournament?.concurrency || 3);
  const pending = comparisons.filter((comparison) => {
    const existing = tournamentResultFor(bundle, comparison.comparisonId);
    return !existing || existing.error;
  });
  await mapWithConcurrency(pending, concurrency, async (comparison, index) => {
    console.log(`[tournament ${index + 1}/${pending.length}] ${comparison.cohortId} ${comparison.comparisonId}`);
    const result = await evaluator({
      comparison,
      runsById,
      apiKey,
      model,
      provider,
      maxAttempts: config.tournament?.maxAttempts,
      retryDelayMs: config.tournament?.retryDelayMs
    });
    const existingIndex = bundle.tournament.comparisons.findIndex((item) => item.comparison?.comparisonId === comparison.comparisonId);
    if (existingIndex === -1) bundle.tournament.comparisons.push(result);
    else bundle.tournament.comparisons[existingIndex] = result;
    await checkpoint();
    await delay(config.requestDelayMs || 0);
    return result;
  });
  bundle.tournament.comparisons.sort((left, right) => (comparisonOrder.get(left.comparison?.comparisonId) ?? Number.MAX_SAFE_INTEGER) - (comparisonOrder.get(right.comparison?.comparisonId) ?? Number.MAX_SAFE_INTEGER));

  const preliminary = aggregateTournament(cohorts, bundle.tournament.comparisons);
  const topImpactComparisonIds = preliminary.cohorts.flatMap((cohort) => {
    const topIds = new Set(cohort.ranking.slice(0, 2).map((candidate) => candidate.candidateId));
    return cohort.comparisons.filter((comparison) => comparison.candidateIds.every((id) => topIds.has(id))).map((comparison) => comparison.comparisonId);
  });
  const mirrorOptions = {
    mirrorEvery: config.tournament?.mirrorEvery === true,
    mirrorLowConfidence: config.tournament?.mirrorLowConfidence !== false,
    mirrorSlight: config.tournament?.mirrorSlight !== false,
    topImpactComparisonIds: config.tournament?.mirrorTopImpact === false ? [] : topImpactComparisonIds,
    explicitComparisonIds: explicitMirrorIds
  };
  for (const result of bundle.tournament.comparisons) {
    if ((result.error && !mirrorOptions.mirrorEvery) || (result.mirror && !result.mirrorError) || !shouldMirrorTournamentResult(result, mirrorOptions)) continue;
    console.log(`[tournament mirror] ${result.comparison.cohortId} ${result.comparison.comparisonId}`);
    const mirror = await evaluator({
      comparison: mirrorTournamentComparison(result.comparison),
      runsById,
      apiKey,
      model,
      provider,
      maxAttempts: config.tournament?.maxAttempts,
      retryDelayMs: config.tournament?.retryDelayMs
    });
    result.mirror = mirror;
    if (!mirror.error) {
      result.mirrorAudit = reconcileTournamentMirror(result, mirror);
      delete result.mirrorError;
    } else result.mirrorError = mirror.error;
    await checkpoint();
    await delay(config.requestDelayMs || 0);
  }
  bundle.tournament = {
    ...bundle.tournament,
    ...aggregateTournament(cohorts, bundle.tournament.comparisons),
    humanReviewShortlist: tournamentHumanReviewShortlist(bundle.tournament, bundle.tournament.comparisons, config.shortlist?.maximum || 10),
    usage: sumTournamentUsage(bundle.tournament.comparisons),
    completedAt: new Date().toISOString()
  };
  bundle.metadata ||= {};
  bundle.metadata.tournamentFlow = config.tournament?.mirrorEvery === true
    ? "complete-round-robin -> full-bidirectional-mirroring -> stable-edge-only-regularized-Bradley-Terry-ranking"
    : "complete-round-robin -> selective-mirroring -> regularized-Bradley-Terry-ranking";
  await checkpoint();
  return bundle;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  if (options.tournamentCohorts != null && (!Number.isInteger(options.tournamentCohorts) || options.tournamentCohorts < 1)) throw new Error("--tournament-cohorts must be a positive integer");
  let config = validateConfig(await loadJson(options.config));
  let bundle;
  let checkpointPath;
  if (options.input) {
    bundle = await loadJson(options.input);
    config = validateConfig(bundle.config || config);
    checkpointPath = path.resolve(options.input);
  }
  config = applyRuntimeMode(config, options);
  if (bundle) bundle.config = config;
  if (!options.input) {
    if (options.reportOnly) throw new Error("--report-only requires --input");
    let evaluatorPreflight = null;
    if (!options.captureOnly) {
      const runtime = resolveEvaluatorRuntime({ config: config.evaluator });
      console.log(`[preflight] ${runtime.provider} ${runtime.model}`);
      evaluatorPreflight = await preflightWithRetry(runtime, config.evaluator);
    }
    bundle = await generateCorpus({
      config,
      onProgress: (task, index, total) => console.log(`[${index + 1}/${total}] ${task.environment.name} ${task.topicConfiguration.id} repetition ${task.repetition}`)
    });
    bundle.metadata = {
      ...bundle.metadata,
      generationOnly: false,
      mode: options.sanity ? "sanity" : "comparison",
      evaluationFlow: "independent-assessment -> deterministic-comparison -> unresolved-only-blinded-arbitration",
      evaluatorPreflight
    };
    bundle.sanity = options.sanity ? sanityAssessment(null, bundle.pairs) : null;
    checkpointPath = path.resolve(options.output, `portfolio-generation-capture-${timestamp()}.json`);
    await writeJsonAtomic(checkpointPath, bundle);
    console.log(`Capture checkpoint: ${checkpointPath}`);
  }

  const sanityMode = bundle.metadata.mode === "sanity" || options.sanity;
  if (!options.reportOnly && !options.captureOnly) {
    const runtime = resolveEvaluatorRuntime({ config: config.evaluator });
    const { apiKey, model, provider } = runtime;
    if (!options.tournamentOnly && needsQualitativeEvaluation(bundle, sanityMode)) {
      if (options.input) {
        console.log(`[preflight] ${model}`);
        bundle.metadata.evaluatorPreflight = await preflightWithRetry(runtime, config.evaluator);
        await writeJsonAtomic(checkpointPath, bundle);
      }
      await evaluateBundle({
        bundle,
        config,
        apiKey,
        model,
        provider,
        sanityMode,
        persist: (current) => writeJsonAtomic(checkpointPath, current)
      });
    }
    if (options.tournament && config.tournament?.enabled !== false) {
      const tournamentModel = process.env[config.tournament?.modelEnv || "TOURNAMENT_EVAL_MODEL"] || model;
      const cohorts = createTournamentCohorts(bundle.runs || [], config.tournament?.pairingSeed || `${config.pairingSeed}:tournament`);
      const selectedCohorts = options.tournamentCohorts ? cohorts.slice(0, options.tournamentCohorts) : cohorts;
      if (needsTournamentEvaluation(bundle, selectedCohorts) || selectedCohorts.some((cohort) => cohort.comparisons.some((comparison) => options.mirrorComparisonIds.includes(comparison.comparisonId)))) {
        await evaluateTournamentBundle({
          bundle,
          config,
          apiKey,
          model: tournamentModel,
          provider,
          cohortLimit: options.tournamentCohorts,
          explicitMirrorIds: options.mirrorComparisonIds,
          persist: (current) => writeJsonAtomic(checkpointPath, current)
        });
      }
    }
  }

  const successfulEvaluations = (bundle.evaluations || []).filter((evaluation) => !evaluation.error && !evaluation.mirrorError);
  if (successfulEvaluations.length) {
    const runsById = new Map(bundle.runs.map((run) => [run.runId, run]));
    bundle.qualitative = aggregateQualitative(successfulEvaluations);
    bundle.shortlist = chooseShortlist(successfulEvaluations, runsById, config.shortlist);
    if (sanityMode) bundle.sanity = sanityAssessment(bundle.qualitative, bundle.pairs);
  }
  if (sanityMode && !bundle.sanity) bundle.sanity = sanityAssessment(null, bundle.pairs || []);
  bundle.metadata.generatedAt = new Date().toISOString();
  if (checkpointPath && !options.reportOnly) await writeJsonAtomic(checkpointPath, bundle);
  if (options.captureOnly) {
    const markdownPath = checkpointPath.replace(/\.json$/i, ".md");
    await writeFile(markdownPath, buildMarkdownReport(bundle), "utf8");
    console.log(`JSON: ${checkpointPath}`);
    console.log(`Markdown: ${markdownPath}`);
    return;
  }
  const stem = `portfolio-generation-evaluation-${timestamp()}`;
  const written = await writeBundle(bundle, options.output, stem);
  console.log(`JSON: ${written.jsonPath}`);
  console.log(`Markdown: ${written.markdownPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
