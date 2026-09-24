import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightEvaluator } from "./evaluator.mjs";
import { resolveEvaluatorRuntime } from "./evaluator-provider.mjs";
import {
  DIMENSION_EVALUATOR_MODEL,
  DIMENSION_IDS,
  EDITORIAL_DIMENSIONS,
  dimensionEvaluationTasks,
  evaluateDimensionOrientation,
  reconcileDimensionOrientations,
  selectDimensionCalibrationComparisons
} from "./dimension-evaluator.mjs";
import { canonicalPairIdentity, createTournamentCohorts } from "./tournament.mjs";

const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 5_000;
const TASK_CONCURRENCY = 6;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArgs(argv) {
  const options = { input: null, holistic: null, output: "dimension-calibration-results", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") options.input = argv[++index];
    else if (argv[index] === "--holistic") options.holistic = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else if (argv[index] === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.input) throw new Error("--input is required");
  if (!options.holistic) throw new Error("--holistic is required");
  return options;
}

async function mapWithConcurrency(items, concurrency, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function taskKey(task) {
  return `${canonicalPairIdentity(task.baseComparison || task.comparison)}|${task.dimensionId}|${task.orientation}`;
}

function usageSummary(records, preflight) {
  return records.reduce((total, record) => {
    const usage = record.usage || {};
    total.apiAttempts += Number(record.attemptCount || 0);
    total.retries += Math.max(0, Number(record.attemptCount || 0) - 1);
    total.failedAttempts += (record.attempts || []).filter((attempt) => attempt.error).length;
    total.failures += record.error ? 1 : 0;
    total.successfulJudgments += record.judgment ? 1 : 0;
    total.inputTokens += Number(usage.input_tokens || 0);
    total.outputTokens += Number(usage.output_tokens || 0);
    total.totalTokens += Number(usage.total_tokens || 0);
    total.cost += Number(usage.cost || 0);
    return total;
  }, {
    apiAttempts: Number(preflight?.attemptCount || 0),
    retries: Math.max(0, Number(preflight?.attemptCount || 0) - 1),
    failedAttempts: Number(preflight?.failedAttempts || 0),
    failures: 0,
    successfulJudgments: 0,
    inputTokens: Number(preflight?.usage?.input_tokens || 0),
    outputTokens: Number(preflight?.usage?.output_tokens || 0),
    totalTokens: Number(preflight?.usage?.total_tokens || 0),
    cost: Number(preflight?.usage?.cost || 0)
  });
}

function holisticOutcome(result) {
  if (!result || result.error || result.mirrorError || result.mirrorAudit?.unresolved) return "unresolved";
  if (result.mirrorAudit?.unstable) return "order_reversal";
  const winner = result.mirrorAudit?.winnerCandidateId || result.mappedJudgment?.winnerCandidateId;
  if (!winner) return "unresolved";
  const candidate = Object.values(result.comparison.mappedCandidates).find((item) => item.candidateId === winner);
  return `${candidate?.environment || winner}_stronger`;
}

function countOutcomes(values) {
  const counts = { control_stronger: 0, control_leaning: 0, equivalent: 0, treatment_leaning: 0, treatment_stronger: 0, order_reversal: 0, failed: 0 };
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

export function summarizeDimensionCalibration({ source, holistic, comparisons, records, preflight, startedAt, completedAt }) {
  const recordMap = new Map(records.map((record) => [record.key, record.result]));
  const holisticMap = new Map((holistic.tournament?.comparisons || []).map((result) => [canonicalPairIdentity(result.comparison), result]));
  const pairs = comparisons.map((comparison) => {
    const pairIdentity = canonicalPairIdentity(comparison);
    const dimensions = Object.fromEntries(DIMENSION_IDS.map((dimensionId) => {
      const original = recordMap.get(`${pairIdentity}|${dimensionId}|original`);
      const mirrored = recordMap.get(`${pairIdentity}|${dimensionId}|mirrored`);
      return [dimensionId, { original, mirrored, reconciled: reconcileDimensionOrientations(comparison, original, mirrored) }];
    }));
    const control = Object.values(comparison.mappedCandidates).find((candidate) => candidate.environment === "control");
    const treatment = Object.values(comparison.mappedCandidates).find((candidate) => candidate.environment === "treatment");
    return {
      pairIdentity,
      cohortId: comparison.cohortId,
      controlCandidateId: control?.candidateId,
      treatmentCandidateId: treatment?.candidateId,
      originalPlacement: structuredClone(comparison.blind),
      holisticQwenOutcome: holisticOutcome(holisticMap.get(pairIdentity)),
      dimensions
    };
  });
  const dimensions = Object.fromEntries(DIMENSION_IDS.map((dimensionId) => {
    const outcomes = pairs.map((pair) => pair.dimensions[dimensionId].reconciled.outcome);
    const positional = { original: { A_stronger: 0, equivalent: 0, B_stronger: 0 }, mirrored: { A_stronger: 0, equivalent: 0, B_stronger: 0 } };
    for (const pair of pairs) {
      for (const orientation of ["original", "mirrored"]) {
        const value = pair.dimensions[dimensionId][orientation]?.judgment?.judgment;
        if (value) positional[orientation][value] += 1;
      }
    }
    const cohortDistributions = Object.fromEntries([...new Set(pairs.map((pair) => pair.cohortId))].map((cohortId) => [cohortId,
      countOutcomes(pairs.filter((pair) => pair.cohortId === cohortId).map((pair) => pair.dimensions[dimensionId].reconciled.outcome))]));
    const counts = countOutcomes(outcomes);
    const completed = outcomes.filter((outcome) => outcome !== "failed").length;
    return [dimensionId, {
      ...EDITORIAL_DIMENSIONS[dimensionId],
      outcomes: counts,
      orderReversalRate: completed ? counts.order_reversal / completed : null,
      usableResultRate: pairs.length ? (completed - counts.order_reversal) / pairs.length : null,
      positional,
      cohortDistributions
    }];
  }));
  const holisticOutcomes = pairs.map((pair) => pair.holisticQwenOutcome);
  const holisticCounts = countOutcomes(holisticOutcomes);
  const holisticCompleted = holisticOutcomes.filter((outcome) => outcome !== "unresolved").length;
  const sourceCohorts = createTournamentCohorts(source.runs, source.config?.tournament?.pairingSeed);
  return {
    schemaVersion: 1,
    evaluatorProvider: "openrouter",
    evaluatorModel: DIMENSION_EVALUATOR_MODEL,
    selection: {
      seed: "dimension-specific-calibration-v1",
      logic: "Two deterministic direct control-vs-treatment pairs from each eligible topic cohort, selected from the existing balanced stratified candidate pool by canonical-pair hash.",
      cohorts: sourceCohorts.length,
      pairCount: pairs.length,
      excludedReliabilityCandidates: sourceCohorts.reduce((sum, cohort) => sum + cohort.excludedCandidates.length, 0),
      callsPlanned: pairs.length * DIMENSION_IDS.length * 2
    },
    dimensions,
    holisticComparison: {
      model: holistic.tournament?.evaluatorModel,
      canonicalPairsFound: pairs.filter((pair) => holisticMap.has(pair.pairIdentity)).length,
      outcomes: holisticCounts,
      orderReversalRate: holisticCompleted ? holisticCounts.order_reversal / holisticCompleted : null
    },
    execution: usageSummary(records.map((record) => record.result), preflight),
    startedAt,
    completedAt,
    runtimeMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    pairs
  };
}

function percent(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function dimensionCalibrationMarkdown(summary) {
  const lines = [
    "# Dimension-specific evaluator calibration",
    "",
    `Evaluator: \`${summary.evaluatorProvider}\` / \`${summary.evaluatorModel}\``,
    "",
    `Selection: ${summary.selection.logic}`,
    "",
    `- Calibration pairs: ${summary.selection.pairCount}`,
    `- Cohorts represented: ${summary.selection.cohorts}`,
    `- Evaluator calls planned: ${summary.selection.callsPlanned}`,
    `- Reliability/fallback candidates excluded: ${summary.selection.excludedReliabilityCandidates}`,
    "",
    "## Dimension outcomes",
    "",
    "| Dimension | Control stronger | Control leaning | Equivalent | Treatment leaning | Treatment stronger | Order reversal | Usable |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...DIMENSION_IDS.map((id) => {
      const item = summary.dimensions[id], o = item.outcomes;
      return `| ${item.label} | ${o.control_stronger} | ${o.control_leaning} | ${o.equivalent} | ${o.treatment_leaning} | ${o.treatment_stronger} | ${o.order_reversal} (${percent(item.orderReversalRate)}) | ${percent(item.usableResultRate)} |`;
    }),
    "",
    "## Holistic comparison on the same pairs",
    "",
    `- Canonical pairs found: ${summary.holisticComparison.canonicalPairsFound}/${summary.selection.pairCount}`,
    `- Holistic order reversals: ${summary.holisticComparison.outcomes.order_reversal}/${summary.selection.pairCount} (${percent(summary.holisticComparison.orderReversalRate)})`,
    "",
    "## Position audit before reconciliation",
    "",
    ...DIMENSION_IDS.flatMap((id) => {
      const item = summary.dimensions[id];
      return [
        `### ${item.label}`,
        "",
        `- Original: ${JSON.stringify(item.positional.original)}`,
        `- Mirrored: ${JSON.stringify(item.positional.mirrored)}`,
        ""
      ];
    }),
    "## Cohort distributions",
    "",
    ...DIMENSION_IDS.flatMap((id) => [
      `### ${summary.dimensions[id].label}`,
      "",
      ...Object.entries(summary.dimensions[id].cohortDistributions).map(([cohort, counts]) => `- ${cohort}: ${JSON.stringify(counts)}`),
      ""
    ]),
    "## Pair audit",
    "",
    ...summary.pairs.flatMap((pair) => [
      `### ${pair.cohortId} — ${pair.controlCandidateId} / ${pair.treatmentCandidateId}`,
      "",
      `- Holistic Qwen: ${pair.holisticQwenOutcome}`,
      ...DIMENSION_IDS.map((id) => {
        const value = pair.dimensions[id];
        return `- ${EDITORIAL_DIMENSIONS[id].label}: **${value.reconciled.outcome}**; original ${value.original?.judgment?.judgment || "failed"} — ${value.original?.judgment?.rationale || value.original?.error}; mirror ${value.mirrored?.judgment?.judgment || "failed"} — ${value.mirrored?.judgment?.rationale || value.mirrored?.error}`;
      }),
      ""
    ]),
    "## API execution",
    "",
    `- Attempts: ${summary.execution.apiAttempts}`,
    `- Retries / failed attempts: ${summary.execution.retries} / ${summary.execution.failedAttempts}`,
    `- Successful judgments / terminal failures: ${summary.execution.successfulJudgments} / ${summary.execution.failures}`,
    `- Tokens: input ${summary.execution.inputTokens}, output ${summary.execution.outputTokens}, total ${summary.execution.totalTokens}`,
    `- Reported OpenRouter cost: $${summary.execution.cost.toFixed(6)}`,
    `- Runtime: ${(summary.runtimeMs / 1000).toFixed(1)} seconds`,
    "",
    "No composite score or overall dimensional pair verdict was created. Ben remains the final editorial judge."
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const source = JSON.parse(await readFile(options.input, "utf8"));
  const holistic = JSON.parse(await readFile(options.holistic, "utf8"));
  if (source.runs?.length !== 66) throw new Error(`Expected stored 66-response corpus; found ${source.runs?.length || 0}`);
  const cohorts = createTournamentCohorts(source.runs, source.config?.tournament?.pairingSeed);
  const comparisons = selectDimensionCalibrationComparisons(cohorts);
  if (cohorts.length !== 11 || comparisons.length !== 22) throw new Error(`Expected 22 pairs across 11 cohorts; found ${comparisons.length} pairs across ${cohorts.length} cohorts`);
  await mkdir(options.output, { recursive: true });
  if (options.dryRun) {
    await writeFile(path.join(options.output, "dimension-calibration-selection.json"), `${JSON.stringify(comparisons, null, 2)}\n`, "utf8");
    return;
  }
  const runtime = resolveEvaluatorRuntime({
    config: { defaultProvider: "openrouter", apiKeyEnvByProvider: { openrouter: "OPENROUTER_API_KEY" }, defaultModel: DIMENSION_EVALUATOR_MODEL }
  });
  if (runtime.provider !== "openrouter" || runtime.model !== DIMENSION_EVALUATOR_MODEL) throw new Error("Dimension calibration provider/model must remain explicitly pinned");
  let preflight;
  let preflightFailures = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      preflight = await preflightEvaluator({ ...runtime, timeoutMs: 120_000 });
      preflight = { ...preflight, attemptCount: attempt, failedAttempts: preflightFailures };
      break;
    } catch (error) {
      preflightFailures += 1;
      if (attempt === MAX_ATTEMPTS) throw error;
      await delay(RETRY_DELAY_MS * attempt);
    }
  }
  const checkpointPath = path.join(options.output, "dimension-calibration-checkpoint.json");
  let checkpoint = { schemaVersion: 1, records: [] };
  try { checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const completed = new Set(checkpoint.records.filter((record) => !record.result?.error).map((record) => record.key));
  const tasks = dimensionEvaluationTasks(comparisons).filter((task) => !completed.has(taskKey(task)));
  const runsById = new Map(source.runs.map((run) => [run.runId, run]));
  let persistChain = Promise.resolve();
  await mapWithConcurrency(tasks, TASK_CONCURRENCY, async (task, index) => {
    console.log(`[dimension ${index + 1}/${tasks.length}] ${task.comparison.cohortId} ${task.dimensionId} ${task.orientation}`);
    const result = await evaluateDimensionOrientation({
      comparison: task.comparison,
      dimensionId: task.dimensionId,
      runsById,
      ...runtime,
      timeoutMs: 120_000,
      maxAttempts: MAX_ATTEMPTS,
      retryDelayMs: RETRY_DELAY_MS
    });
    const key = taskKey(task);
    const existing = checkpoint.records.findIndex((record) => record.key === key);
    const record = { key, pairIdentity: canonicalPairIdentity(task.baseComparison || task.comparison), orientation: task.orientation, dimensionId: task.dimensionId, result };
    if (existing === -1) checkpoint.records.push(record); else checkpoint.records[existing] = record;
    persistChain = persistChain.then(() => writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8"));
    await persistChain;
  });
  const completedAt = new Date().toISOString();
  const summary = summarizeDimensionCalibration({ source, holistic, comparisons, records: checkpoint.records, preflight, startedAt, completedAt });
  await writeFile(path.join(options.output, "dimension-calibration.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(options.output, "dimension-calibration.md"), dimensionCalibrationMarkdown(summary), "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
}
