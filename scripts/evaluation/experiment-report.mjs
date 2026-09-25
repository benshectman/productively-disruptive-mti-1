import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIMENSION_IDS } from "./dimension-evaluator.mjs";

export function parseExperimentReportArgs(argv) {
  const options = { corpus: null, evaluation: null, output: "experiment-artifacts/summary" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corpus") options.corpus = argv[++index];
    else if (argv[index] === "--evaluation") options.evaluation = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.corpus) throw new Error("--corpus is required");
  if (!options.evaluation) throw new Error("--evaluation is required");
  return options;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function evidenceDiagnostics(run) {
  const sections = run.diagnostics?.sections || [];
  const detailed = sections.map((section) => section.evidence).filter(Boolean);
  const displayed = new Set(detailed.flatMap((item) => item.finalDisplayedEvidenceIds || []));
  return {
    returnedEvidenceCount: Array.isArray(run.evidence) ? run.evidence.length : null,
    eligibleEvidenceCount: detailed.length ? detailed.reduce((sum, item) => sum + Number(item.eligibleFactCount || 0), 0) : null,
    displayedEvidenceCount: detailed.length ? displayed.size : null,
    proofItemCount: run.prose?.sections?.reduce((sum, section) => sum + (section.proofItems?.length || 0), 0) ?? null
  };
}

export function summarizeDeterministicMetrics(corpus) {
  const reliability = corpus.reliability?.byEnvironment || {};
  return Object.fromEntries(["control", "treatment"].map((environment) => {
    const runs = (corpus.runs || []).filter((run) => run.environment === environment);
    const aggregate = reliability[environment] || {};
    const diagnostics = runs.map(evidenceDiagnostics);
    const availableRejectionRuns = Number(aggregate.rejectionDiagnosticsAvailableRuns || 0);
    return [environment, {
      environmentId: runs[0]?.environmentId || corpus.metadata?.environments?.[environment]?.id,
      runCount: runs.length,
      successfulRuns: runs.filter((run) => run.ok).length,
      generationFailures: runs.filter((run) => !run.ok).length,
      fallbackFields: aggregate.fallbackFields ?? null,
      totalFields: aggregate.totalFields ?? null,
      fallbackRate: aggregate.fallbackFieldRate ?? null,
      validationRejections: aggregate.rejectionCount ?? null,
      runsWithValidationRejections: aggregate.runsWithRejections ?? null,
      validationRejectionRunRate: availableRejectionRuns ? aggregate.runsWithRejections / availableRejectionRuns : null,
      numericGroundingFailures: aggregate.rejectionsByCategory?.["numeric-grounding"] || 0,
      evidenceProvenanceFailures: aggregate.rejectionsByCategory?.["evidence-provenance"] || 0,
      rejectionDiagnosticsAvailableRuns: availableRejectionRuns,
      generationStatuses: aggregate.generationStatuses || {},
      validationStatuses: aggregate.validationFailures || {},
      latencyMs: aggregate.latencyMs || null,
      evidenceDiagnostics: {
        averageReturnedEvidenceCount: average(diagnostics.map((item) => item.returnedEvidenceCount)),
        averageEligibleEvidenceCountWhereAvailable: average(diagnostics.map((item) => item.eligibleEvidenceCount)),
        averageDisplayedEvidenceCountWhereAvailable: average(diagnostics.map((item) => item.displayedEvidenceCount)),
        averageProofItemCount: average(diagnostics.map((item) => item.proofItemCount))
      }
    }];
  }));
}

export function createExperimentSummary(corpus, evaluation) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    experiment: {
      control: corpus.metadata?.environments?.control,
      treatment: corpus.metadata?.environments?.treatment,
      topicConfigurationCount: corpus.metadata?.topicConfigurationCount,
      runsPerTopic: corpus.metadata?.repetitions,
      responseCount: corpus.runs?.length || 0
    },
    deterministic: summarizeDeterministicMetrics(corpus),
    evaluator: {
      provider: evaluation.evaluatorProvider,
      model: evaluation.evaluatorModel,
      selectedPairCount: evaluation.selection?.pairCount || 0
    },
    dimensions: Object.fromEntries(DIMENSION_IDS.map((id) => [id, {
      label: evaluation.dimensions[id].label,
      outcomes: evaluation.dimensions[id].outcomes,
      usableDenominator: evaluation.dimensions[id].usableDenominator,
      evaluatedPairCount: evaluation.dimensions[id].evaluatedPairCount
    }]))
  };
}

function display(value) {
  return value == null ? "n/a" : value;
}

function percent(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function experimentSummaryMarkdown(summary) {
  const dimensionRows = DIMENSION_IDS.map((id) => {
    const item = summary.dimensions[id];
    const outcome = item.outcomes;
    return `| ${item.label} | ${outcome.control_stronger} | ${outcome.control_leaning} | ${outcome.equivalent} | ${outcome.treatment_leaning} | ${outcome.treatment_stronger} | ${outcome.order_reversal} | ${item.usableDenominator} | ${outcome.failed} |`;
  });
  const deterministicRows = ["control", "treatment"].map((name) => {
    const item = summary.deterministic[name];
    return `| ${name} (\`${item.environmentId}\`) | ${item.successfulRuns}/${item.runCount} | ${item.generationFailures} | ${display(item.fallbackFields)} (${percent(item.fallbackRate)}) | ${display(item.validationRejections)} (${percent(item.validationRejectionRunRate)}) | ${item.numericGroundingFailures} | ${item.evidenceProvenanceFailures} | ${display(item.latencyMs?.median)} | ${display(item.latencyMs?.p90)} |`;
  });
  const evidenceRows = ["control", "treatment"].map((name) => {
    const item = summary.deterministic[name];
    const evidence = item.evidenceDiagnostics;
    return `| ${name} | ${display(evidence.averageReturnedEvidenceCount)} | ${display(evidence.averageEligibleEvidenceCountWhereAvailable)} | ${display(evidence.averageDisplayedEvidenceCountWhereAvailable)} | ${display(evidence.averageProofItemCount)} |`;
  });
  return `${[
    "# Portfolio experiment summary",
    "",
    `Control: \`${summary.experiment.control?.id}\`. Treatment: \`${summary.experiment.treatment?.id}\`. Corpus: ${summary.experiment.responseCount} responses across ${summary.experiment.topicConfigurationCount} topic combinations, ${summary.experiment.runsPerTopic} runs per side.`,
    "",
    `Evaluator: \`${summary.evaluator.provider}\` / \`${summary.evaluator.model}\`.`,
    "",
    "## Dimension results",
    "",
    "| Dimension | Control stronger | Control leaning | Equivalent | Treatment leaning | Treatment stronger | Order reversal | Usable denominator | Evaluator failures |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...dimensionRows,
    "",
    "## Deterministic metrics",
    "",
    "| Environment | Successful runs | Generation failures | Fallback fields | Validation rejections | Numeric grounding | Evidence provenance | Median ms | P90 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...deterministicRows,
    "",
    "## Evidence diagnostics",
    "",
    "Averages use only runs where the corresponding diagnostic is available.",
    "",
    "| Environment | Returned evidence | Eligible evidence | Displayed evidence | Proof items |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...evidenceRows,
    "",
    "Order reversals invalidate only the affected dimension for that pair. Generation failures are excluded from editorial evaluation. No composite score or overall winner was created."
  ].join("\n")}\n`;
}

async function main() {
  const options = parseExperimentReportArgs(process.argv.slice(2));
  const corpus = JSON.parse(await readFile(options.corpus, "utf8"));
  const evaluation = JSON.parse(await readFile(options.evaluation, "utf8"));
  const summary = createExperimentSummary(corpus, evaluation);
  await mkdir(options.output, { recursive: true });
  await writeFile(path.join(options.output, "portfolio-experiment-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(options.output, "portfolio-experiment-summary.md"), experimentSummaryMarkdown(summary), "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
