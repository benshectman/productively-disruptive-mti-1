import { createHash } from "node:crypto";
import { generationType } from "./core.mjs";
import { buildDefaultEvaluatorEvidenceContext } from "./evidence-context.mjs";

export const TOURNAMENT_WINNERS = ["A_stronger", "B_stronger", "unclear"];
export const TOURNAMENT_MARGINS = ["slight", "clear", "substantial"];
export const TOURNAMENT_CONFIDENCE = ["low", "medium", "high"];

function stableHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function topicMetadata(run) {
  return {
    id: run.topicConfigurationId,
    label: run.topicConfigurationLabel,
    topics: run.selectedTopicIds
  };
}

export function tournamentCandidate(run) {
  return {
    candidateId: run.runId,
    runId: run.runId,
    environment: run.environment,
    environmentId: run.environmentId,
    repetition: run.repetition,
    topicConfigurationId: run.topicConfigurationId
  };
}

function orientPair(left, right, aCounts, seed, pairKey) {
  const leftA = aCounts.get(left.candidateId) || 0;
  const rightA = aCounts.get(right.candidateId) || 0;
  let a = left;
  let b = right;
  if (rightA < leftA || (rightA === leftA && Number.parseInt(stableHash(`${seed}:${pairKey}`).slice(0, 2), 16) % 2 === 1)) {
    a = right;
    b = left;
  }
  aCounts.set(a.candidateId, (aCounts.get(a.candidateId) || 0) + 1);
  return { a, b };
}

export function createTournamentCohorts(runs, seed = "portfolio-tournament-v1") {
  const grouped = new Map();
  for (const run of runs) {
    const id = run.topicConfigurationId;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(run);
  }
  return [...grouped.entries()].map(([topicConfigurationId, topicRuns]) => {
    const orderedRuns = [...topicRuns].sort((left, right) =>
      left.environment.localeCompare(right.environment) || left.repetition - right.repetition || left.runId.localeCompare(right.runId));
    const eligibleRuns = orderedRuns.filter((run) => generationType(run) === "generated");
    const excludedCandidates = orderedRuns.filter((run) => generationType(run) !== "generated").map((run) => ({
      ...tournamentCandidate(run),
      reason: generationType(run) === "capture-failure" ? "generation-failed" : "fallback-containing-response"
    }));
    const candidates = eligibleRuns.map(tournamentCandidate);
    const unorderedPairs = [];
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) unorderedPairs.push([candidates[left], candidates[right]]);
    }
    unorderedPairs.sort((left, right) => stableHash(`${seed}:${topicConfigurationId}:${left[0].candidateId}:${left[1].candidateId}`)
      .localeCompare(stableHash(`${seed}:${topicConfigurationId}:${right[0].candidateId}:${right[1].candidateId}`)));
    const aCounts = new Map(candidates.map((candidate) => [candidate.candidateId, 0]));
    const comparisons = unorderedPairs.map(([left, right]) => {
      const canonicalIds = [left.candidateId, right.candidateId].sort();
      const pairKey = canonicalIds.join(":");
      const { a, b } = orientPair(left, right, aCounts, seed, pairKey);
      return {
        comparisonId: stableHash(`${seed}:${topicConfigurationId}:${pairKey}`).slice(0, 20),
        cohortId: topicConfigurationId,
        topicConfiguration: topicMetadata(eligibleRuns[0] || orderedRuns[0]),
        candidateIds: canonicalIds,
        blind: { A: a.candidateId, B: b.candidateId },
        placement: {
          strategy: "seeded-candidate-balanced",
          A: a.candidateId,
          B: b.candidateId
        },
        mappedCandidates: { A: a, B: b }
      };
    });
    return {
      cohortId: topicConfigurationId,
      topicConfiguration: topicMetadata(eligibleRuns[0] || orderedRuns[0]),
      candidates,
      excludedCandidates,
      comparisons
    };
  });
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, itemIndex) => itemIndex !== index))
    .map((rest) => [value, ...rest]));
}

function directComparison(cohort, left, right) {
  return cohort.comparisons.find((comparison) => comparison.candidateIds.includes(left.candidateId)
    && comparison.candidateIds.includes(right.candidateId));
}

export function selectStratifiedDirectComparisons(cohorts, seed = "portfolio-cross-provider-validation-v1") {
  const optionsByCohort = cohorts.map((cohort) => {
    const control = cohort.candidates.filter((candidate) => candidate.environment === "control")
      .sort((left, right) => left.repetition - right.repetition || left.candidateId.localeCompare(right.candidateId));
    const treatment = cohort.candidates.filter((candidate) => candidate.environment === "treatment")
      .sort((left, right) => left.repetition - right.repetition || left.candidateId.localeCompare(right.candidateId));
    if (control.length !== 3 || treatment.length !== 3) {
      throw new Error(`Cohort ${cohort.cohortId} must contain exactly three generated control and treatment repetitions`);
    }
    return permutations(treatment).map((orderedTreatment) => {
      const comparisons = control.map((candidate, index) => directComparison(cohort, candidate, orderedTreatment[index]));
      if (comparisons.some((comparison) => !comparison)) throw new Error(`Cohort ${cohort.cohortId} is missing a direct comparison`);
      return {
        comparisons,
        treatmentAsA: comparisons.filter((comparison) => comparison.mappedCandidates.A.environment === "treatment").length,
        signature: comparisons.map((comparison) => comparison.comparisonId).join(":")
      };
    }).sort((left, right) => stableHash(`${seed}:${cohort.cohortId}:${left.signature}`)
      .localeCompare(stableHash(`${seed}:${cohort.cohortId}:${right.signature}`)));
  });

  let states = new Map([[0, { treatmentAsA: 0, selections: [], signature: "" }]]);
  for (let index = 0; index < cohorts.length; index += 1) {
    const next = new Map();
    for (const state of states.values()) {
      for (const option of optionsByCohort[index]) {
        const treatmentAsA = state.treatmentAsA + option.treatmentAsA;
        const signature = `${state.signature}:${option.signature}`;
        const candidate = { treatmentAsA, selections: [...state.selections, option], signature };
        const existing = next.get(treatmentAsA);
        if (!existing || stableHash(`${seed}:${candidate.signature}`).localeCompare(stableHash(`${seed}:${existing.signature}`)) < 0) {
          next.set(treatmentAsA, candidate);
        }
      }
    }
    states = next;
  }
  const total = cohorts.length * 3;
  const selected = [...states.values()].sort((left, right) =>
    Math.abs(left.treatmentAsA - total / 2) - Math.abs(right.treatmentAsA - total / 2)
    || stableHash(`${seed}:${left.signature}`).localeCompare(stableHash(`${seed}:${right.signature}`)))[0];
  return selected.selections.flatMap((selection) => selection.comparisons);
}

export function tournamentRequest(comparison, runsById) {
  const a = runsById.get(comparison.blind.A);
  const b = runsById.get(comparison.blind.B);
  const combinedProse = { sections: [...(a.prose?.sections || []), ...(b.prose?.sections || [])] };
  return {
    topicConfiguration: comparison.topicConfiguration,
    evidenceContext: buildDefaultEvaluatorEvidenceContext({ selectedTopicIds: comparison.topicConfiguration.topics, prose: combinedProse }),
    responseA: { prose: a.prose, citedEvidence: a.evidence },
    responseB: { prose: b.prose, citedEvidence: b.evidence }
  };
}

export function mirrorTournamentComparison(comparison) {
  return {
    ...comparison,
    comparisonId: `${comparison.comparisonId}-mirrored`,
    mirroredFromComparisonId: comparison.comparisonId,
    blind: { A: comparison.blind.B, B: comparison.blind.A },
    placement: {
      ...comparison.placement,
      A: comparison.blind.B,
      B: comparison.blind.A,
      mirroredFromComparisonId: comparison.comparisonId
    },
    mappedCandidates: { A: comparison.mappedCandidates.B, B: comparison.mappedCandidates.A }
  };
}

export function mapTournamentJudgment(comparison, judgment) {
  const winnerPosition = judgment.winner === "A_stronger" ? "A" : judgment.winner === "B_stronger" ? "B" : null;
  const loserPosition = winnerPosition === "A" ? "B" : winnerPosition === "B" ? "A" : null;
  return {
    ...judgment,
    winnerPosition,
    loserPosition,
    winnerCandidateId: winnerPosition ? comparison.blind[winnerPosition] : null,
    loserCandidateId: loserPosition ? comparison.blind[loserPosition] : null,
    winnerEnvironment: winnerPosition ? comparison.mappedCandidates[winnerPosition].environment : null,
    loserEnvironment: loserPosition ? comparison.mappedCandidates[loserPosition].environment : null
  };
}

export function reconcileTournamentMirror(original, mirrored) {
  const originalWinner = original.mappedJudgment?.winnerCandidateId || null;
  const mirroredWinner = mirrored.mappedJudgment?.winnerCandidateId || null;
  const unstable = Boolean(originalWinner && mirroredWinner && originalWinner !== mirroredWinner);
  const unresolved = !originalWinner || !mirroredWinner;
  return {
    unstable,
    unresolved,
    originalWinnerCandidateId: originalWinner,
    mirroredWinnerCandidateId: mirroredWinner,
    winnerCandidateId: unstable || unresolved ? null : originalWinner,
    reason: unstable
      ? "The preference reversed when A/B presentation order was mirrored."
      : unresolved
        ? "At least one orientation returned an exceptional unclear result."
        : "Both orientations preferred the same underlying candidate."
  };
}

export function shouldMirrorTournamentResult(result, options = {}) {
  if (options.explicitComparisonIds?.includes(result.comparison.comparisonId)) return true;
  if (result.error || !result.mappedJudgment?.winnerCandidateId) return false;
  if (options.mirrorLowConfidence !== false && result.judgment.confidence === "low") return true;
  if (options.mirrorSlight !== false && result.judgment.margin === "slight") return true;
  return Boolean(options.topImpactComparisonIds?.includes(result.comparison.comparisonId));
}

function decisiveResult(result) {
  if (!result || result.error || result.mirrorAudit?.unstable || result.mirrorAudit?.unresolved) return null;
  return result.mirrorAudit?.winnerCandidateId || result.mappedJudgment?.winnerCandidateId || null;
}

function bradleyTerry(candidates, results, prior = 0.5) {
  const ids = candidates.map((candidate) => candidate.candidateId);
  const index = new Map(ids.map((id, position) => [id, position]));
  const wins = Array(ids.length).fill(0);
  const games = Array.from({ length: ids.length }, () => Array(ids.length).fill(0));
  for (const result of results) {
    const [leftId, rightId] = result.comparison.candidateIds;
    const left = index.get(leftId);
    const right = index.get(rightId);
    if (left == null || right == null) continue;
    games[left][right] += 2 * prior;
    games[right][left] += 2 * prior;
    wins[left] += prior;
    wins[right] += prior;
    const winner = decisiveResult(result);
    if (winner === leftId) { games[left][right] += 1; games[right][left] += 1; wins[left] += 1; }
    if (winner === rightId) { games[left][right] += 1; games[right][left] += 1; wins[right] += 1; }
  }
  let strengths = Array(ids.length).fill(1);
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const next = strengths.map((_, i) => {
      let denominator = 0;
      for (let j = 0; j < strengths.length; j += 1) {
        if (i !== j && games[i][j]) denominator += games[i][j] / (strengths[i] + strengths[j]);
      }
      return denominator ? wins[i] / denominator : 1;
    });
    const mean = next.reduce((sum, value) => sum + value, 0) / next.length || 1;
    for (let i = 0; i < next.length; i += 1) next[i] /= mean;
    const delta = Math.max(...next.map((value, i) => Math.abs(value - strengths[i])));
    strengths = next;
    if (delta < 1e-10) break;
  }
  return Object.fromEntries(ids.map((id, i) => [id, strengths[i]]));
}

export function rankTournamentCohort(cohort, results) {
  const relevant = results.filter((result) => result.comparison.cohortId === cohort.cohortId);
  const strengths = bradleyTerry(cohort.candidates, relevant);
  const rows = cohort.candidates.map((candidate) => {
    const candidateResults = relevant.filter((result) => result.comparison.candidateIds.includes(candidate.candidateId));
    let wins = 0;
    let losses = 0;
    let unresolved = 0;
    for (const result of candidateResults) {
      const winner = decisiveResult(result);
      if (!winner) unresolved += 1;
      else if (winner === candidate.candidateId) wins += 1;
      else losses += 1;
    }
    return { ...candidate, wins, losses, unresolved, relativeStrength: strengths[candidate.candidateId] || 1 };
  });
  rows.sort((left, right) => right.relativeStrength - left.relativeStrength || right.wins - left.wins || left.candidateId.localeCompare(right.candidateId));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function counts(values) {
  return Object.fromEntries(values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map()));
}

export function aggregateTournament(cohorts, results) {
  const rankedCohorts = cohorts.map((cohort) => ({ ...cohort, ranking: rankTournamentCohort(cohort, results) }));
  const decisive = results.filter((result) => decisiveResult(result));
  const direct = decisive.filter((result) => {
    const environments = result.comparison.candidateIds.map((id) => result.comparison.mappedCandidates.A.candidateId === id
      ? result.comparison.mappedCandidates.A.environment : result.comparison.mappedCandidates.B.environment);
    return new Set(environments).size === 2;
  });
  const directWins = { control: 0, treatment: 0 };
  for (const result of direct) directWins[result.mirrorAudit?.winnerCandidateId ?
    [result.comparison.mappedCandidates.A, result.comparison.mappedCandidates.B].find((candidate) => candidate.candidateId === result.mirrorAudit.winnerCandidateId).environment
    : result.mappedJudgment.winnerEnvironment] += 1;
  const allRanks = { control: [], treatment: [] };
  const placement = { control: { first: 0, top2: 0, top3: 0, bottom: 0 }, treatment: { first: 0, top2: 0, top3: 0, bottom: 0 } };
  for (const cohort of rankedCohorts) {
    for (const candidate of cohort.ranking) {
      allRanks[candidate.environment]?.push(candidate.rank);
      if (candidate.rank === 1) placement[candidate.environment].first += 1;
      if (candidate.rank <= 2) placement[candidate.environment].top2 += 1;
      if (candidate.rank <= 3) placement[candidate.environment].top3 += 1;
      if (candidate.rank === cohort.ranking.length) placement[candidate.environment].bottom += 1;
    }
  }
  const judgmentPasses = results.flatMap((result) => [
    result.judgment ? { pass: "original", winner: result.judgment.winner } : null,
    result.mirror?.judgment ? { pass: "mirror", winner: result.mirror.judgment.winner } : null
  ]).filter((pass) => pass && ["A_stronger", "B_stronger"].includes(pass.winner));
  const passCounts = (passes) => ({
    A: passes.filter((pass) => pass.winner === "A_stronger").length,
    B: passes.filter((pass) => pass.winner === "B_stronger").length
  });
  const allPassCounts = passCounts(judgmentPasses);
  const originalPassCounts = passCounts(judgmentPasses.filter((pass) => pass.pass === "original"));
  const mirrorPassCounts = passCounts(judgmentPasses.filter((pass) => pass.pass === "mirror"));
  const mirroredCount = results.filter((result) => result.mirror).length;
  const unstableCount = results.filter((result) => result.mirrorAudit?.unstable).length;
  const substantialTreatmentLosses = direct.filter((result) => {
    const winnerEnvironment = result.mirrorAudit?.winnerCandidateId
      ? [result.comparison.mappedCandidates.A, result.comparison.mappedCandidates.B].find((candidate) => candidate.candidateId === result.mirrorAudit.winnerCandidateId).environment
      : result.mappedJudgment.winnerEnvironment;
    return winnerEnvironment === "control" && result.judgment.margin === "substantial";
  }).map((result) => result.comparison.comparisonId);
  const treatmentBottomTopics = rankedCohorts.filter((cohort) => cohort.ranking.at(-1)?.environment === "treatment").map((cohort) => cohort.cohortId);
  const repeatedTreatmentRegressions = rankedCohorts.filter((cohort) => {
    const cohortResults = direct.filter((result) => result.comparison.cohortId === cohort.cohortId);
    const losses = cohortResults.filter((result) => (result.mirrorAudit?.winnerCandidateId
      ? [result.comparison.mappedCandidates.A, result.comparison.mappedCandidates.B].find((candidate) => candidate.candidateId === result.mirrorAudit.winnerCandidateId).environment
      : result.mappedJudgment.winnerEnvironment) === "control").length;
    return cohortResults.length >= 3 && losses / cohortResults.length >= 2 / 3;
  }).map((cohort) => cohort.cohortId);
  const treatmentRate = direct.length ? directWins.treatment / direct.length : null;
  const interpretation = substantialTreatmentLosses.length || (treatmentRate != null && treatmentRate < 0.35) || repeatedTreatmentRegressions.length >= 2
    ? "appears meaningfully worse"
    : treatmentRate != null && treatmentRate > 0.65
      ? "appears directionally better"
      : "appears roughly equivalent";
  return {
    method: "regularized Bradley-Terry-style estimate (0.5 symmetric pseudo-win per candidate per matchup)",
    caveat: "Relative strength is a ranking aid derived from this cohort's pairwise preferences, not an absolute quality score.",
    cohorts: rankedCohorts,
    summary: {
      interpretation,
      cohortCount: rankedCohorts.length,
      comparisonCount: results.length,
      decisiveComparisonCount: decisive.length,
      directControlTreatmentComparisons: direct.length,
      directWins,
      directTreatmentWinRate: treatmentRate,
      placement,
      rankStatistics: Object.fromEntries(Object.entries(allRanks).map(([environment, ranks]) => [environment, {
        mean: ranks.length ? ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length : null,
        median: median(ranks)
      }])),
      margins: counts(results.filter((result) => result.judgment).map((result) => result.judgment.margin)),
      confidence: counts(results.filter((result) => result.judgment).map((result) => result.judgment.confidence)),
      lowConfidenceComparisons: results.filter((result) => result.judgment?.confidence === "low").map((result) => result.comparison.comparisonId),
      unclearComparisons: results.filter((result) => result.judgment?.winner === "unclear").map((result) => result.comparison.comparisonId),
      evaluatorErrors: results.filter((result) => result.error || result.mirrorError).map((result) => result.comparison.comparisonId),
      unstableComparisons: results.filter((result) => result.mirrorAudit?.unstable).map((result) => result.comparison.comparisonId),
      mirroredComparisons: mirroredCount,
      substantialTreatmentLosses,
      treatmentBottomTopics,
      repeatedTreatmentRegressions,
      positionBias: {
        allPasses: { ...allPassCounts, total: judgmentPasses.length },
        originalPasses: { ...originalPassCounts, total: originalPassCounts.A + originalPassCounts.B },
        mirroredPasses: { ...mirrorPassCounts, total: mirrorPassCounts.A + mirrorPassCounts.B },
        unstableMirroredComparisons: unstableCount,
        unstableMirrorRate: mirroredCount ? unstableCount / mirroredCount : null,
        suspicious: mirroredCount >= 4 && unstableCount / mirroredCount >= 0.25
      }
    }
  };
}

export function tournamentHumanReviewShortlist(tournament, results, maximum = 10) {
  const priority = (result) =>
    (result.error || result.mirrorError ? 120 : 0)
    + (result.mirrorAudit?.unstable ? 100 : 0)
    + (result.judgment?.winner === "unclear" ? 80 : 0)
    + (result.mappedJudgment?.loserEnvironment === "treatment" && result.judgment?.margin === "substantial" ? 60 : 0)
    + (result.judgment?.confidence === "low" ? 30 : 0)
    + (result.judgment?.margin === "slight" ? 10 : 0);
  return [...results].filter((result) => priority(result) > 0).sort((left, right) => priority(right) - priority(left)).slice(0, maximum)
    .map((result) => ({ comparisonId: result.comparison.comparisonId, cohortId: result.comparison.cohortId, priority: priority(result), reason: result.error || result.mirrorError
      ? "evaluator error" : result.mirrorAudit?.unstable ? "position instability" : result.judgment?.winner === "unclear" ? "exceptional unclear result" : result.mappedJudgment?.loserEnvironment === "treatment" && result.judgment?.margin === "substantial"
        ? "substantial treatment loss" : result.judgment?.confidence === "low" ? "low confidence" : "slight margin" }));
}
