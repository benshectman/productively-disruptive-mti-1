import { captureGeneration, createBlindPairs, aggregateReliability, resolveEnvironment } from "./core.mjs";

const delay = (milliseconds) => milliseconds > 0
  ? new Promise((resolve) => setTimeout(resolve, milliseconds))
  : Promise.resolve();

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, consume));
  return results;
}

export function configWithRunsPerTopic(config, runsPerTopic = config.repetitions) {
  if (!Number.isInteger(runsPerTopic) || runsPerTopic < 1) throw new Error("runs-per-topic must be a positive integer");
  return { ...config, repetitions: runsPerTopic };
}

export function createGenerationTasks(config, environments) {
  const tasks = [];
  for (const topicConfiguration of config.topicConfigurations) {
    for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
      for (const environment of environments) tasks.push({ environment, topicConfiguration, repetition });
    }
  }
  return tasks;
}

export async function generateCorpus({
  config,
  environment = process.env,
  capture = captureGeneration,
  onProgress = () => {}
}) {
  const control = resolveEnvironment(config, "control", environment);
  const treatment = resolveEnvironment(config, "treatment", environment);
  const tasks = createGenerationTasks(config, [control, treatment]);
  const runs = await mapWithConcurrency(tasks, config.captureConcurrency || 1, async (task, index) => {
    onProgress(task, index, tasks.length);
    const captured = await capture({ ...task, timeoutMs: config.requestTimeoutMs });
    await delay(config.requestDelayMs || 0);
    return captured;
  });
  const pairs = createBlindPairs(runs, config.pairingSeed);
  const generationModels = Object.fromEntries(["control", "treatment"].map((name) => [name,
    [...new Set(runs.filter((run) => run.environment === name).map((run) => run.diagnostics?.model).filter(Boolean))]
  ]));
  const reportedModels = Object.values(generationModels);
  const sameGenerationModel = reportedModels.some((models) => models.length > 1)
    ? false
    : reportedModels.every((models) => models.length === 1)
      ? generationModels.control[0] === generationModels.treatment[0]
      : null;
  return {
    schemaVersion: 1,
    metadata: {
      generatedAt: new Date().toISOString(),
      artifactPurpose: "fresh-experiment-corpus",
      generationOnly: true,
      mode: "comparison",
      environments: { control, treatment },
      topicConfigurationCount: config.topicConfigurations.length,
      repetitions: config.repetitions,
      expectedRunCount: config.topicConfigurations.length * config.repetitions * 2,
      pairingSeed: config.pairingSeed,
      generationModels,
      sameGenerationModel
    },
    config,
    runs,
    reliability: aggregateReliability(runs, config.reliabilityRegression),
    pairs,
    evaluations: [],
    qualitative: null,
    shortlist: [],
    sanity: null
  };
}

export function assertSameGenerationModel(corpus) {
  if (corpus.metadata?.sameGenerationModel === false) {
    throw new Error(`Control and treatment reported different generation models: ${JSON.stringify(corpus.metadata.generationModels)}`);
  }
  return corpus;
}
