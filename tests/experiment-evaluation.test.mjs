import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateCorpus } from "../scripts/evaluation/corpus.mjs";
import {
  createExperimentComparisons,
  reconcileDimensionRecords,
  runDimensionTournament
} from "../scripts/evaluation/dimension-tournament.mjs";
import { DIMENSION_IDS, reconcileDimensionOrientations } from "../scripts/evaluation/dimension-evaluator.mjs";
import { createExperimentSummary } from "../scripts/evaluation/experiment-report.mjs";
import { canonicalPairIdentity, mirrorTournamentComparison } from "../scripts/evaluation/tournament.mjs";

const defaultConfig = JSON.parse(await readFile(new URL("../scripts/evaluation/default-config.json", import.meta.url), "utf8"));
const environment = {
  EVAL_CONTROL_URL: "https://control.example.com",
  EVAL_TREATMENT_URL: "https://treatment.example.com",
  EVAL_CONTROL_ID: "develop",
  EVAL_TREATMENT_ID: "experiment/evidence-selection"
};

function capturedRun({ environment: target, topicConfiguration, repetition }, overrides = {}) {
  return {
    runId: `${target.name}-${topicConfiguration.id}-${repetition}`,
    environment: target.name,
    environmentId: target.id,
    topicConfigurationId: topicConfiguration.id,
    topicConfigurationLabel: topicConfiguration.label,
    selectedTopicIds: topicConfiguration.topics,
    repetition,
    ok: true,
    durationMs: target.name === "control" ? 100 : 120,
    generationStatus: "ai",
    validationStatus: null,
    totalFallbackFields: 0,
    fallbackSectionCount: 0,
    fieldProvenance: [],
    diagnostics: {
      model: "gpt-4.1-mini",
      status: "ai",
      generatedFields: 12,
      fallbackFields: 0,
      totalFields: 12,
      aiSections: 4,
      mixedSections: 0,
      fallbackSections: 0,
      totalSections: 4,
      rejections: [],
      sections: []
    },
    prose: { sections: [{ id: "one", headline: "Headline", summary: "Summary", detail: "Detail", proofItems: [] }] },
    evidence: [],
    ...overrides
  };
}

async function fullCorpus(captureOverride) {
  return generateCorpus({
    config: structuredClone(defaultConfig),
    environment,
    capture: async (task) => captureOverride ? captureOverride(task) : capturedRun(task)
  });
}

function evaluatorResult(comparison, judgment = "equivalent") {
  const winnerPosition = judgment === "A_stronger" ? "A" : judgment === "B_stronger" ? "B" : null;
  return {
    judgment: { judgment, rationale: "Dimension-specific rationale" },
    mappedJudgment: {
      judgment,
      rationale: "Dimension-specific rationale",
      winnerPosition,
      winnerCandidateId: winnerPosition ? comparison.blind[winnerPosition] : null,
      winnerEnvironment: winnerPosition ? comparison.mappedCandidates[winnerPosition].environment : null
    },
    attemptCount: 1,
    attempts: []
  };
}

describe("fresh experiment evaluation flow", () => {
  it("creates a generation-only 66-response corpus from configured topics and repetitions", async () => {
    const corpus = await fullCorpus();
    expect(corpus.metadata.generationOnly).toBe(true);
    expect(corpus.metadata.topicConfigurationCount).toBe(11);
    expect(corpus.metadata.repetitions).toBe(3);
    expect(corpus.metadata.expectedRunCount).toBe(66);
    expect(corpus.runs).toHaveLength(66);
    expect(new Set(corpus.runs.map((run) => run.topicConfigurationId))).toEqual(new Set(defaultConfig.topicConfigurations.map((item) => item.id)));
    expect(corpus.evaluations).toEqual([]);
  });

  it("preserves three control and three treatment runs per topic and selects 33 direct pairs", async () => {
    const corpus = await fullCorpus();
    for (const topic of defaultConfig.topicConfigurations) {
      const runs = corpus.runs.filter((run) => run.topicConfigurationId === topic.id);
      expect(runs.filter((run) => run.environment === "control").map((run) => run.repetition).sort()).toEqual([1, 2, 3]);
      expect(runs.filter((run) => run.environment === "treatment").map((run) => run.repetition).sort()).toEqual([1, 2, 3]);
    }
    expect(createExperimentComparisons(corpus).comparisons).toHaveLength(33);
  });

  it("reuses the corpus without regeneration and mirrors all three dimensions", async () => {
    const corpus = await fullCorpus();
    let evaluatorCalls = 0;
    const output = await runDimensionTournament({
      corpus,
      runtime: { provider: "openai", model: "gpt-5.6-luna", apiKey: "test" },
      evaluate: async ({ comparison }) => {
        evaluatorCalls += 1;
        return evaluatorResult(comparison);
      },
      concurrency: 8,
      maxAttempts: 1,
      retryDelayMs: 0
    });
    expect(evaluatorCalls).toBe(33 * 3 * 2);
    expect(output.raw.records).toHaveLength(198);
    for (const dimensionId of DIMENSION_IDS) {
      expect(output.raw.records.filter((record) => record.dimensionId === dimensionId && record.orientation === "original")).toHaveLength(33);
      expect(output.raw.records.filter((record) => record.dimensionId === dimensionId && record.orientation === "mirrored")).toHaveLength(33);
      expect(output.reconciled.dimensions[dimensionId].usableDenominator).toBe(33);
    }
  });

  it("invalidates an order reversal only for its own dimension", async () => {
    const corpus = await fullCorpus();
    const comparison = createExperimentComparisons(corpus).comparisons[0];
    const mirrored = mirrorTournamentComparison(comparison);
    const reversal = reconcileDimensionOrientations(comparison, evaluatorResult(comparison, "A_stronger"), evaluatorResult(mirrored, "A_stronger"));
    const stable = reconcileDimensionOrientations(comparison, evaluatorResult(comparison), evaluatorResult(mirrored));
    expect(reversal.outcome).toBe("order_reversal");
    expect(stable.outcome).toBe("equivalent");
  });

  it("excludes generation failures from editorial comparisons", async () => {
    const corpus = await fullCorpus((task) => capturedRun(task,
      task.environment.name === "control" && task.topicConfiguration.id === "none" && task.repetition === 1
        ? { ok: false, generationStatus: "network-error", networkError: "unavailable" }
        : {}));
    const selection = createExperimentComparisons(corpus);
    expect(corpus.runs.filter((run) => !run.ok)).toHaveLength(1);
    expect(selection.comparisons).toHaveLength(32);
    expect(selection.comparisons.some((comparison) => comparison.candidateIds.includes("control-none-1"))).toBe(false);
  });

  it("keeps evaluator failures separate and uses independent dimension denominators", async () => {
    const corpus = await fullCorpus();
    const comparison = createExperimentComparisons(corpus).comparisons[0];
    const pairIdentity = canonicalPairIdentity(comparison);
    const records = [];
    for (const dimensionId of DIMENSION_IDS) {
      for (const orientation of ["original", "mirrored"]) {
        const oriented = orientation === "original" ? comparison : mirrorTournamentComparison(comparison);
        records.push({
          key: `${pairIdentity}|${dimensionId}|${orientation}`,
          result: dimensionId === "evidenceSelection" && orientation === "mirrored"
            ? { error: "evaluator unavailable" }
            : evaluatorResult(oriented)
        });
      }
    }
    const evaluation = reconcileDimensionRecords({
      corpus,
      comparisons: [comparison],
      records,
      runtime: { provider: "openai", model: "gpt-5.6-luna" },
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z"
    });
    expect(evaluation.dimensions.evidenceSelection.outcomes.failed).toBe(1);
    expect(evaluation.dimensions.evidenceSelection.usableDenominator).toBe(0);
    expect(evaluation.dimensions.narrativeSynthesis.usableDenominator).toBe(1);
    expect(evaluation.dimensions.claimContributionQuality.usableDenominator).toBe(1);
    const summary = createExperimentSummary(corpus, evaluation);
    expect(summary.deterministic.control.generationFailures).toBe(0);
    expect(summary.dimensions).not.toHaveProperty("overall");
    expect(summary).not.toHaveProperty("winner");
  });

  it("defines three distinct workflow jobs and passes artifacts between them", async () => {
    const workflow = await readFile(new URL("../.github/workflows/portfolio-experiment-evaluation.yml", import.meta.url), "utf8");
    expect(workflow).toContain("name: Portfolio Experiment Evaluation");
    expect(workflow).toContain("generate-corpus:");
    expect(workflow).toContain("evaluate-dimensions:");
    expect(workflow).toContain("summarize-experiment:");
    expect(workflow).toContain("portfolio-experiment-corpus-${{ github.run_id }}");
    expect(workflow).toContain("npm run eval:dimension-tournament");
    expect(workflow).not.toContain("npm run eval:harness");
  });
});
