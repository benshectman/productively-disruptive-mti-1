#!/usr/bin/env node
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateQualitative,
  aggregateReliability,
  captureGeneration,
  chooseShortlist,
  createBlindPairs,
  mirrorPair,
  reconcileMirroredEvaluations,
  resolveEnvironment,
  sanityAssessment,
  validateConfig
} from "./core.mjs";
import { evaluatePair, preflightEvaluator } from "./evaluator.mjs";
import { buildMarkdownReport } from "./report.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export function args(argv) {
  const result = { config: path.join(scriptDirectory, "default-config.json"), output: "evaluation-results", input: null, captureOnly: false, reportOnly: false, sanity: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") result.config = argv[++index];
    else if (value === "--output") result.output = argv[++index];
    else if (value === "--input") result.input = argv[++index];
    else if (value === "--evaluate-existing") result.input = argv[++index];
    else if (value === "--capture-only") result.captureOnly = true;
    else if (value === "--report-only") result.reportOnly = true;
    else if (value === "--sanity") result.sanity = true;
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
  npm run eval:harness -- --input CAPTURE.json [--output DIR]  # backward-compatible alias
  npm run eval:report -- --input RESULTS.json [--output DIR]

Required for capture:
  EVAL_CONTROL_URL       Branch deploy or Deploy Preview base URL
  EVAL_TREATMENT_URL     Branch deploy or Deploy Preview base URL

Required for qualitative evaluation:
  OPENAI_API_KEY         Evaluator API key (never written to output)

Optional:
  EVAL_CONTROL_ID, EVAL_TREATMENT_ID, EVAL_MODEL

The combined command runs an evaluator preflight before capture, writes an atomic capture checkpoint before qualitative evaluation, and saves evaluator progress after every pair.

Use --sanity with equivalent endpoints to run mirrored A/B evaluator passes and add the position-bias audit.`;
}

const delay = (milliseconds) => milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();

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

function upsertEvaluation(bundle, pairId, evaluation) {
  bundle.evaluations ||= [];
  const index = bundle.evaluations.findIndex((item) => item.pair?.pairId === pairId);
  if (index === -1) bundle.evaluations.push(evaluation);
  else bundle.evaluations[index] = evaluation;
}

export function needsQualitativeEvaluation(bundle, sanityMode = bundle.metadata?.mode === "sanity") {
  return (bundle.pairs || []).some((pair) => {
    const evaluation = evaluationForPair(bundle, pair.pairId);
    if (!evaluation || evaluation.error) return true;
    return sanityMode && (!evaluation.evaluatorPasses || evaluation.mirrorError);
  });
}

export async function evaluateBundle({ bundle, config, apiKey, model, sanityMode, evaluator = evaluatePair, persist = async () => {} }) {
  const runsById = new Map(bundle.runs.map((run) => [run.runId, run]));
  for (let index = 0; index < bundle.pairs.length; index += 1) {
    const pair = bundle.pairs[index];
    const existing = evaluationForPair(bundle, pair.pairId);
    if (existing && !existing.error) continue;
    console.log(`[evaluator ${index + 1}/${bundle.pairs.length}] ${pair.pairId} original`);
    const evaluation = await evaluator({ pair, runsById, apiKey, model });
    upsertEvaluation(bundle, pair.pairId, evaluation);
    await persist(bundle);
    await delay(config.requestDelayMs || 0);
  }
  if (sanityMode) {
    for (let index = 0; index < bundle.pairs.length; index += 1) {
      const pair = bundle.pairs[index];
      const existing = evaluationForPair(bundle, pair.pairId);
      if (!existing || existing.error || (existing.evaluatorPasses && !existing.mirrorError)) continue;
      const original = existing.evaluatorPasses?.original || existing;
      console.log(`[evaluator ${index + 1}/${bundle.pairs.length}] ${pair.pairId} mirrored`);
      const mirrored = await evaluator({ pair: mirrorPair(pair), runsById, apiKey, model });
      const evaluation = mirrored.error
        ? { ...original, mirrorError: mirrored.error, failedMirrorPass: mirrored }
        : reconcileMirroredEvaluations(original, mirrored);
      upsertEvaluation(bundle, pair.pairId, evaluation);
      await persist(bundle);
      await delay(config.requestDelayMs || 0);
    }
  }
  const order = new Map(bundle.pairs.map((pair, index) => [pair.pairId, index]));
  bundle.evaluations.sort((left, right) => (order.get(left.pair?.pairId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.pair?.pairId) ?? Number.MAX_SAFE_INTEGER));
  bundle.metadata.qualitativePassesPerPair = sanityMode ? 2 : 1;
  return bundle;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  let config = validateConfig(await loadJson(options.config));
  let bundle;
  let checkpointPath;
  if (options.input) {
    bundle = await loadJson(options.input);
    config = validateConfig(bundle.config || config);
    checkpointPath = path.resolve(options.input);
  } else {
    if (options.reportOnly) throw new Error("--report-only requires --input");
    let evaluatorPreflight = null;
    if (!options.captureOnly) {
      const apiKey = process.env[config.evaluator.apiKeyEnv];
      if (!apiKey) throw new Error(`Set ${config.evaluator.apiKeyEnv}, or rerun with --capture-only`);
      const model = process.env[config.evaluator.modelEnv] || config.evaluator.defaultModel;
      console.log(`[preflight] ${model}`);
      evaluatorPreflight = await preflightEvaluator({ apiKey, model });
    }
    const control = resolveEnvironment(config, "control");
    const treatment = resolveEnvironment(config, "treatment");
    const tasks = [];
    for (const topicConfiguration of config.topicConfigurations) {
      for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
        for (const environment of [control, treatment]) {
          tasks.push({ environment, topicConfiguration, repetition });
        }
      }
    }
    const runs = await mapWithConcurrency(tasks, config.captureConcurrency || 1, async (task, index) => {
      console.log(`[${index + 1}/${tasks.length}] ${task.environment.name} ${task.topicConfiguration.id} repetition ${task.repetition}`);
      const captured = await captureGeneration({ ...task, timeoutMs: config.requestTimeoutMs });
      await delay(config.requestDelayMs || 0);
      return captured;
    });
    const pairs = createBlindPairs(runs, config.pairingSeed);
    bundle = {
      schemaVersion: 1,
      metadata: {
        generatedAt: new Date().toISOString(),
        mode: options.sanity ? "sanity" : "comparison",
        environments: { control, treatment },
        topicConfigurationCount: config.topicConfigurations.length,
        repetitions: config.repetitions,
        pairingSeed: config.pairingSeed,
        evaluatorPreflight
      },
      config,
      runs,
      reliability: aggregateReliability(runs, config.reliabilityRegression),
      pairs,
      evaluations: [],
      qualitative: null,
      shortlist: [],
      sanity: options.sanity ? sanityAssessment(null, pairs) : null
    };
    checkpointPath = path.resolve(options.output, `portfolio-generation-capture-${timestamp()}.json`);
    await writeJsonAtomic(checkpointPath, bundle);
    console.log(`Capture checkpoint: ${checkpointPath}`);
  }

  const sanityMode = bundle.metadata.mode === "sanity" || options.sanity;
  if (!options.reportOnly && !options.captureOnly) {
    const apiKey = process.env[config.evaluator.apiKeyEnv];
    if (!apiKey) throw new Error(`Set ${config.evaluator.apiKeyEnv}, or rerun with --capture-only`);
    const model = process.env[config.evaluator.modelEnv] || config.evaluator.defaultModel;
    if (needsQualitativeEvaluation(bundle, sanityMode)) {
      if (options.input) {
        console.log(`[preflight] ${model}`);
        bundle.metadata.evaluatorPreflight = await preflightEvaluator({ apiKey, model });
        await writeJsonAtomic(checkpointPath, bundle);
      }
      await evaluateBundle({
        bundle,
        config,
        apiKey,
        model,
        sanityMode,
        persist: (current) => writeJsonAtomic(checkpointPath, current)
      });
    }
  }

  const successfulEvaluations = (bundle.evaluations || []).filter((evaluation) => !evaluation.error && !evaluation.mirrorError && (!sanityMode || evaluation.evaluatorPasses));
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
