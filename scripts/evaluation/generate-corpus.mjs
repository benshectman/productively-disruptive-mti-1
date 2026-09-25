import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSameGenerationModel, configWithRunsPerTopic, generateCorpus } from "./corpus.mjs";
import { validateConfig } from "./core.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export function parseGenerateCorpusArgs(argv) {
  const options = {
    config: path.join(scriptDirectory, "default-config.json"),
    output: "experiment-artifacts/corpus.json",
    runsPerTopic: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") options.config = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else if (argv[index] === "--runs-per-topic") options.runsPerTopic = Number.parseInt(argv[++index], 10);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

async function main() {
  const options = parseGenerateCorpusArgs(process.argv.slice(2));
  let config = validateConfig(JSON.parse(await readFile(options.config, "utf8")));
  if (options.runsPerTopic != null) config = configWithRunsPerTopic(config, options.runsPerTopic);
  const corpus = await generateCorpus({
    config,
    onProgress: (task, index, total) => console.log(
      `[${index + 1}/${total}] ${task.environment.name} ${task.topicConfiguration.id} repetition ${task.repetition}`
    )
  });
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  console.log(`Corpus: ${path.resolve(options.output)}`);
  console.log(`Runs: ${corpus.runs.length}; pairs: ${corpus.pairs.length}`);
  assertSameGenerationModel(corpus);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
