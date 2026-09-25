import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightEvaluator } from "./evaluator.mjs";
import { resolveEvaluatorRuntime } from "./evaluator-provider.mjs";
import {
  DIMENSION_IDS,
  EDITORIAL_DIMENSIONS,
  dimensionEvaluationTasks,
  evaluateDimensionOrientation,
  reconcileDimensionOrientations
} from "./dimension-evaluator.mjs";
import { canonicalPairIdentity, createTournamentCohorts, selectStratifiedDirectComparisons } from "./tournament.mjs";
import { mapWithConcurrency } from "./corpus.mjs";

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_CONCURRENCY = 6;

export function parseDimensionTournamentArgs(argv) {
  const options = { input: null, output: "experiment-artifacts/dimension-evaluation" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") options.input = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.input) throw new Error("--input is required");
  return options;
}

export function createExperimentComparisons(corpus) {
  const seed = corpus.config?.tournament?.pairingSeed || `${corpus.config?.pairingSeed || "portfolio-experiment"}:dimension`;
  const cohorts = createTournamentCohorts(corpus.runs || [], seed);
  return {
    seed,
    cohorts,
    comparisons: selectStratifiedDirectComparisons(cohorts, `${seed}:direct`)
  };
}

export function dimensionTaskKey(task) {
  return `${canonicalPairIdentity(task.baseComparison || task.comparison)}|${task.dimensionId}|${task.orientation}`;
}

function countOutcomes(values) {
  const counts = {
    control_stronger: 0,
    control_leaning: 0,
    equivalent: 0,
    treatment_leaning: 0,
    treatment_stronger: 0,
    order_reversal: 0,
    failed: 0
  };
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

export function reconcileDimensionRecords({ corpus, comparisons, records, runtime, preflight = null, startedAt, completedAt }) {
  const recordMap = new Map(records.map((record) => [record.key, record.result]));
  const pairs = comparisons.map((comparison) => {
    const pairIdentity = canonicalPairIdentity(comparison);
    const dimensions = Object.fromEntries(DIMENSION_IDS.map((dimensionId) => {
      const original = recordMap.get(`${pairIdentity}|${dimensionId}|original`);
      const mirrored = recordMap.get(`${pairIdentity}|${dimensionId}|mirrored`);
      return [dimensionId, {
        original: original ? { judgment: original.judgment || null, error: original.error || null } : null,
        mirrored: mirrored ? { judgment: mirrored.judgment || null, error: mirrored.error || null } : null,
        reconciled: reconcileDimensionOrientations(comparison, original, mirrored)
      }];
    }));
    const control = Object.values(comparison.mappedCandidates).find((item) => item.environment === "control");
    const treatment = Object.values(comparison.mappedCandidates).find((item) => item.environment === "treatment");
    return {
      pairIdentity,
      cohortId: comparison.cohortId,
      controlCandidateId: control?.candidateId,
      treatmentCandidateId: treatment?.candidateId,
      originalPlacement: structuredClone(comparison.blind),
      dimensions
    };
  });
  const dimensions = Object.fromEntries(DIMENSION_IDS.map((dimensionId) => {
    const outcomes = pairs.map((pair) => pair.dimensions[dimensionId].reconciled.outcome);
    const counts = countOutcomes(outcomes);
    const usableDenominator = counts.control_stronger + counts.control_leaning + counts.equivalent
      + counts.treatment_leaning + counts.treatment_stronger;
    return [dimensionId, {
      ...EDITORIAL_DIMENSIONS[dimensionId],
      outcomes: counts,
      usableDenominator,
      evaluatedPairCount: pairs.length
    }];
  }));
  return {
    schemaVersion: 1,
    sourceCorpus: {
      generatedAt: corpus.metadata?.generatedAt,
      runCount: corpus.runs?.length || 0,
      controlId: corpus.metadata?.environments?.control?.id,
      treatmentId: corpus.metadata?.environments?.treatment?.id
    },
    evaluatorProvider: runtime.provider,
    evaluatorModel: runtime.model,
    selection: {
      logic: "One deterministic, repetition-balanced control/treatment comparison per available run in each topic cohort.",
      pairCount: pairs.length,
      callsPlanned: pairs.length * DIMENSION_IDS.length * 2
    },
    preflight,
    dimensions,
    startedAt,
    completedAt,
    pairs
  };
}

async function writeJsonAtomic(filename, value) {
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

async function preflightWithRetry(runtime, maxAttempts, retryDelayMs) {
  let failedAttempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await preflightEvaluator({ ...runtime, timeoutMs: 120_000 });
      return { ...result, attemptCount: attempt, failedAttempts };
    } catch (error) {
      failedAttempts += 1;
      if (attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

export async function runDimensionTournament({
  corpus,
  runtime,
  checkpoint = { schemaVersion: 1, records: [] },
  persist = async () => {},
  evaluate = evaluateDimensionOrientation,
  concurrency = DEFAULT_CONCURRENCY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  preflight = null
}) {
  const startedAt = checkpoint.startedAt || new Date().toISOString();
  const { comparisons } = createExperimentComparisons(corpus);
  const completed = new Set(checkpoint.records.filter((record) => !record.result?.error).map((record) => record.key));
  const tasks = dimensionEvaluationTasks(comparisons).filter((task) => !completed.has(dimensionTaskKey(task)));
  const runsById = new Map(corpus.runs.map((run) => [run.runId, run]));
  let persistChain = Promise.resolve();
  await mapWithConcurrency(tasks, concurrency, async (task, index) => {
    console.log(`[dimension ${index + 1}/${tasks.length}] ${task.comparison.cohortId} ${task.dimensionId} ${task.orientation}`);
    const result = await evaluate({
      comparison: task.comparison,
      dimensionId: task.dimensionId,
      runsById,
      ...runtime,
      timeoutMs: 120_000,
      maxAttempts,
      retryDelayMs
    });
    const key = dimensionTaskKey(task);
    const record = {
      key,
      pairIdentity: canonicalPairIdentity(task.baseComparison || task.comparison),
      orientation: task.orientation,
      dimensionId: task.dimensionId,
      result
    };
    const existing = checkpoint.records.findIndex((item) => item.key === key);
    if (existing === -1) checkpoint.records.push(record); else checkpoint.records[existing] = record;
    checkpoint.startedAt = startedAt;
    checkpoint.evaluatorProvider = runtime.provider;
    checkpoint.evaluatorModel = runtime.model;
    persistChain = persistChain.then(() => persist(structuredClone(checkpoint)));
    await persistChain;
  });
  const completedAt = new Date().toISOString();
  return {
    raw: { ...checkpoint, preflight, completedAt },
    reconciled: reconcileDimensionRecords({ corpus, comparisons, records: checkpoint.records, runtime, preflight, startedAt, completedAt })
  };
}

export function dimensionResultsMarkdown(results) {
  const rows = DIMENSION_IDS.map((id) => {
    const item = results.dimensions[id];
    const outcomes = item.outcomes;
    return `| ${item.label} | ${outcomes.control_stronger} | ${outcomes.control_leaning} | ${outcomes.equivalent} | ${outcomes.treatment_leaning} | ${outcomes.treatment_stronger} | ${outcomes.order_reversal} | ${item.usableDenominator} | ${outcomes.failed} |`;
  });
  return `${[
    "# Dimension-specific experiment evaluation",
    "",
    `Evaluator: \`${results.evaluatorProvider}\` / \`${results.evaluatorModel}\``,
    "",
    "| Dimension | Control stronger | Control leaning | Equivalent | Treatment leaning | Treatment stronger | Order reversal | Usable denominator | Evaluator failures |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "No composite score or overall winner was created. Order reversals are excluded only from the affected dimension denominator."
  ].join("\n")}\n`;
}

async function main() {
  const options = parseDimensionTournamentArgs(process.argv.slice(2));
  const corpus = JSON.parse(await readFile(options.input, "utf8"));
  const runtime = resolveEvaluatorRuntime({
    config: {
      defaultProvider: "openai",
      providerEnv: "EVAL_PROVIDER",
      modelEnv: "EVAL_MODEL",
      apiKeyEnvByProvider: { openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }
    }
  });
  await mkdir(options.output, { recursive: true });
  const rawPath = path.join(options.output, "dimension-evaluation-raw.json");
  let checkpoint = { schemaVersion: 1, records: [] };
  try { checkpoint = JSON.parse(await readFile(rawPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  checkpoint = {
    ...checkpoint,
    startedAt: checkpoint.startedAt || new Date().toISOString(),
    evaluatorProvider: runtime.provider,
    evaluatorModel: runtime.model
  };
  await writeJsonAtomic(rawPath, checkpoint);
  let preflight;
  try {
    preflight = await preflightWithRetry(runtime, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_DELAY_MS);
  } catch (error) {
    await writeJsonAtomic(rawPath, { ...checkpoint, terminalEvaluatorFailure: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const output = await runDimensionTournament({
    corpus,
    runtime,
    checkpoint,
    preflight,
    persist: (current) => writeJsonAtomic(rawPath, current)
  });
  await writeJsonAtomic(rawPath, output.raw);
  await writeJsonAtomic(path.join(options.output, "dimension-evaluation-results.json"), output.reconciled);
  await writeFile(path.join(options.output, "dimension-evaluation-results.md"), dimensionResultsMarkdown(output.reconciled), "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
