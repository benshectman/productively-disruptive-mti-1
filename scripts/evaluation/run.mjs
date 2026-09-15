#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateQualitative,
  aggregateReliability,
  captureGeneration,
  chooseShortlist,
  createBlindPairs,
  resolveEnvironment,
  sanityAssessment,
  validateConfig
} from "./core.mjs";
import { evaluatePair } from "./evaluator.mjs";
import { buildMarkdownReport } from "./report.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const result = { config: path.join(scriptDirectory, "default-config.json"), output: "evaluation-results", input: null, captureOnly: false, reportOnly: false, sanity: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") result.config = argv[++index];
    else if (value === "--output") result.output = argv[++index];
    else if (value === "--input") result.input = argv[++index];
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
  npm run eval:harness -- --input CAPTURE.json [--output DIR]
  npm run eval:report -- --input RESULTS.json [--output DIR]

Required for capture:
  EVAL_CONTROL_URL       Branch deploy or Deploy Preview base URL
  EVAL_TREATMENT_URL     Branch deploy or Deploy Preview base URL

Required for qualitative evaluation:
  OPENAI_API_KEY         Evaluator API key (never written to output)

Optional:
  EVAL_CONTROL_ID, EVAL_TREATMENT_ID, EVAL_MODEL

Use --sanity with equivalent endpoints to add the A/B position-bias audit.`;
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

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { console.log(help()); return; }
  let config = validateConfig(await loadJson(options.config));
  let bundle;
  if (options.input) {
    bundle = await loadJson(options.input);
    config = validateConfig(bundle.config || config);
  } else {
    if (options.reportOnly) throw new Error("--report-only requires --input");
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
        pairingSeed: config.pairingSeed
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
  }

  if (!options.reportOnly && !options.captureOnly && !bundle.evaluations?.length) {
    const apiKey = process.env[config.evaluator.apiKeyEnv];
    if (!apiKey) throw new Error(`Set ${config.evaluator.apiKeyEnv}, or rerun with --capture-only`);
    const model = process.env[config.evaluator.modelEnv] || config.evaluator.defaultModel;
    const runsById = new Map(bundle.runs.map((run) => [run.runId, run]));
    bundle.evaluations = [];
    for (let index = 0; index < bundle.pairs.length; index += 1) {
      console.log(`[evaluator ${index + 1}/${bundle.pairs.length}] ${bundle.pairs[index].pairId}`);
      bundle.evaluations.push(await evaluatePair({ pair: bundle.pairs[index], runsById, apiKey, model }));
      await delay(config.requestDelayMs || 0);
    }
  }

  const successfulEvaluations = (bundle.evaluations || []).filter((evaluation) => !evaluation.error);
  if (successfulEvaluations.length) {
    const runsById = new Map(bundle.runs.map((run) => [run.runId, run]));
    bundle.qualitative = aggregateQualitative(successfulEvaluations);
    bundle.shortlist = chooseShortlist(successfulEvaluations, runsById, config.shortlist);
    if (bundle.metadata.mode === "sanity" || options.sanity) bundle.sanity = sanityAssessment(bundle.qualitative, bundle.pairs);
  }
  if ((bundle.metadata.mode === "sanity" || options.sanity) && !bundle.sanity) bundle.sanity = sanityAssessment(null, bundle.pairs || []);
  bundle.metadata.generatedAt = new Date().toISOString();
  const stem = `portfolio-generation-evaluation-${timestamp()}`;
  const written = await writeBundle(bundle, options.output, stem);
  console.log(`JSON: ${written.jsonPath}`);
  console.log(`Markdown: ${written.markdownPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
