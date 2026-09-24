import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  DIMENSION_EVALUATOR_MODEL,
  DIMENSION_IDS,
  EDITORIAL_DIMENSIONS,
  assertDimensionJudgment,
  buildDimensionEvaluatorBody,
  dimensionEvaluationTasks,
  evaluateDimensionOrientation,
  reconcileDimensionOrientations
} from "../scripts/evaluation/dimension-evaluator.mjs";
import { createTournamentCohorts, mirrorTournamentComparison } from "../scripts/evaluation/tournament.mjs";

function candidate(candidateId, environment, repetition = 1) {
  return { candidateId, runId: candidateId, environment, environmentId: environment, repetition, topicConfigurationId: "topic" };
}

function comparison() {
  const control = candidate("control-1", "control");
  const treatment = candidate("treatment-1", "treatment");
  return {
    comparisonId: "pair-1",
    cohortId: "topic",
    topicConfiguration: { id: "topic", label: "Topic", topics: ["T-001"] },
    candidateIds: [control.candidateId, treatment.candidateId].sort(),
    blind: { A: control.candidateId, B: treatment.candidateId },
    placement: { strategy: "test", A: control.candidateId, B: treatment.candidateId },
    mappedCandidates: { A: control, B: treatment }
  };
}

function run(runId, environment, fallback = false) {
  return {
    runId,
    environment,
    environmentId: environment,
    repetition: Number(runId.at(-1)) || 1,
    topicConfigurationId: "topic",
    topicConfigurationLabel: "Topic",
    selectedTopicIds: ["T-001"],
    ok: true,
    generationStatus: "ai",
    totalFallbackFields: fallback ? 1 : 0,
    fallbackSectionCount: fallback ? 1 : 0,
    diagnostics: { status: fallback ? "fallback" : "ai", fallbackFields: fallback ? 1 : 0 },
    prose: { sections: [{ id: "one", headline: runId, summary: "summary", detail: "detail", proofItems: [] }] },
    evidence: []
  };
}

function resultFor(comp, judgment, rationale = "Dimension-specific reason") {
  const winnerPosition = judgment === "A_stronger" ? "A" : judgment === "B_stronger" ? "B" : null;
  return {
    judgment: { judgment, rationale },
    mappedJudgment: {
      judgment,
      rationale,
      winnerPosition,
      winnerCandidateId: winnerPosition ? comp.blind[winnerPosition] : null,
      winnerEnvironment: winnerPosition ? comp.mappedCandidates[winnerPosition].environment : null
    }
  };
}

describe("dimension-specific evaluator architecture", () => {
  it("defines exactly the three consolidated dimensions from the independent rubric", () => {
    expect(DIMENSION_IDS).toEqual(["evidenceSelection", "narrativeSynthesis", "claimContributionQuality"]);
    expect(EDITORIAL_DIMENSIONS.evidenceSelection.sourceCriteria).toEqual(["topicRelevance", "selectivity", "evidenceEconomy"]);
    expect(EDITORIAL_DIMENSIONS.evidenceSelection.definition).toBe("Assesses whether the response prioritizes the evidence most relevant to the selected topic, chooses the most useful evidence rather than trying to include everything available, and uses that evidence efficiently so each fact earns its place.");
    expect(EDITORIAL_DIMENSIONS.narrativeSynthesis.sourceCriteria).toEqual(["synthesis", "coherence", "nonRepetition", "readability"]);
    expect(EDITORIAL_DIMENSIONS.narrativeSynthesis.definition).toBe("Assesses whether the response combines evidence into a meaningful point of view or narrative rather than presenting disconnected facts, hangs together logically and structurally as a unified piece, avoids unnecessary repetition, and remains clear, fluent, and easy to follow.");
    expect(EDITORIAL_DIMENSIONS.claimContributionQuality.sourceCriteria).toEqual(["specificity", "groundedness", "attributionDiscipline"]);
    expect(EDITORIAL_DIMENSIONS.claimContributionQuality.definition).toBe("Assesses whether claims are concrete and appropriately detailed, remain within the approved evidence without unsupported inference or embellishment, and accurately distinguish Ben's own contribution from team or organizational contributions and outcomes.");
  });

  it("uses only judgment and rationale, with a publication-material equivalent option", () => {
    const body = buildDimensionEvaluatorBody({ example: true }, "evidenceSelection", DIMENSION_EVALUATOR_MODEL);
    expect(body.text.format.schema.required).toEqual(["judgment", "rationale"]);
    expect(body.text.format.schema.properties).not.toHaveProperty("margin");
    expect(body.text.format.schema.properties).not.toHaveProperty("confidence");
    expect(body.instructions).toContain("no meaningful editorial difference");
    expect(assertDimensionJudgment({ judgment: "A_stronger", rationale: "Materially better selection" })).toBeTruthy();
    expect(assertDimensionJudgment({ judgment: "equivalent", rationale: "No material difference" })).toBeTruthy();
    expect(assertDimensionJudgment({ judgment: "B_stronger", rationale: "Materially better selection" })).toBeTruthy();
    expect(() => assertDimensionJudgment({ judgment: "A_stronger", margin: "clear", confidence: "high", rationale: "No" })).toThrow();
  });

  it("creates six independent tasks and reverses every dimension orientation", () => {
    const comp = comparison();
    const tasks = dimensionEvaluationTasks([comp]);
    expect(tasks).toHaveLength(6);
    expect(new Set(tasks.map((task) => task.dimensionId))).toEqual(new Set(DIMENSION_IDS));
    for (const id of DIMENSION_IDS) {
      const [original, mirrored] = tasks.filter((task) => task.dimensionId === id);
      expect(original.orientation).toBe("original");
      expect(mirrored.orientation).toBe("mirrored");
      expect(mirrored.comparison.blind).toEqual({ A: comp.blind.B, B: comp.blind.A });
    }
  });

  it("reconciles by underlying identity across every required outcome", () => {
    const comp = comparison();
    const mirror = mirrorTournamentComparison(comp);
    expect(reconcileDimensionOrientations(comp, resultFor(comp, "A_stronger"), resultFor(mirror, "B_stronger")).outcome).toBe("control_stronger");
    expect(reconcileDimensionOrientations(comp, resultFor(comp, "A_stronger"), resultFor(mirror, "equivalent")).outcome).toBe("control_leaning");
    expect(reconcileDimensionOrientations(comp, resultFor(comp, "equivalent"), resultFor(mirror, "B_stronger")).outcome).toBe("control_leaning");
    expect(reconcileDimensionOrientations(comp, resultFor(comp, "equivalent"), resultFor(mirror, "equivalent")).outcome).toBe("equivalent");
    expect(reconcileDimensionOrientations(comp, resultFor(comp, "B_stronger"), resultFor(mirror, "A_stronger")).outcome).toBe("treatment_stronger");
    expect(reconcileDimensionOrientations(comp, resultFor(comp, "B_stronger"), resultFor(mirror, "equivalent")).outcome).toBe("treatment_leaning");
    const reversal = reconcileDimensionOrientations(comp, resultFor(comp, "A_stronger"), resultFor(mirror, "A_stronger"));
    expect(reversal).toMatchObject({ outcome: "order_reversal", directional: false, winnerCandidateId: null });
  });

  it("preserves fallback exclusion before dimensional evaluation", () => {
    const cohort = createTournamentCohorts([
      run("control-1", "control"), run("control-2", "control", true),
      run("treatment-1", "treatment"), run("treatment-2", "treatment")
    ])[0];
    expect(cohort.candidates.map((item) => item.candidateId)).not.toContain("control-2");
    expect(cohort.excludedCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ candidateId: "control-2", reason: "fallback-containing-response" })]));
  });

  it("retries invalid output and keeps the paid Qwen model explicitly pinned", async () => {
    expect(DIMENSION_EVALUATOR_MODEL).toBe("qwen/qwen3-235b-a22b-2507");
    const workflow = await readFile(new URL("../.github/workflows/dimension-evaluator-calibration.yml", import.meta.url), "utf8");
    expect(workflow).toContain("EVAL_PROVIDER: openrouter");
    expect(workflow).toContain("EVAL_MODEL: qwen/qwen3-235b-a22b-2507");
    const comp = comparison();
    const runsById = new Map([run("control-1", "control"), run("treatment-1", "treatment")].map((item) => [item.runId, item]));
    let calls = 0;
    const fetcher = async (_url, init) => {
      calls += 1;
      const request = JSON.parse(init.body);
      expect(request.model).toBe(DIMENSION_EVALUATOR_MODEL);
      expect(request).not.toHaveProperty("response_format");
      const content = calls === 1 ? "not-json" : JSON.stringify({ judgment: "equivalent", rationale: "No publication-material difference" });
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) };
    };
    const result = await evaluateDimensionOrientation({
      comparison: comp,
      dimensionId: "narrativeSynthesis",
      runsById,
      apiKey: "test",
      model: DIMENSION_EVALUATOR_MODEL,
      provider: "openrouter",
      fetcher,
      maxAttempts: 2
    });
    expect(calls).toBe(2);
    expect(result.attemptCount).toBe(2);
    expect(result.judgment).toEqual({ judgment: "equivalent", rationale: "No publication-material difference" });
  });

  it("preserves dimensions independently without creating an overall verdict", () => {
    const comp = comparison();
    const mirror = mirrorTournamentComparison(comp);
    const dimensions = {
      evidenceSelection: reconcileDimensionOrientations(comp, resultFor(comp, "B_stronger"), resultFor(mirror, "A_stronger")),
      narrativeSynthesis: reconcileDimensionOrientations(comp, resultFor(comp, "B_stronger"), resultFor(mirror, "equivalent")),
      claimContributionQuality: reconcileDimensionOrientations(comp, resultFor(comp, "equivalent"), resultFor(mirror, "equivalent"))
    };
    const pair = { dimensions };
    expect(pair).not.toHaveProperty("overall");
    expect(pair.dimensions).toMatchObject({
      evidenceSelection: { outcome: "treatment_stronger" },
      narrativeSynthesis: { outcome: "treatment_leaning" },
      claimContributionQuality: { outcome: "equivalent" }
    });
  });
});
