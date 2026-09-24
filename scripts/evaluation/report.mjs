import { CRITERIA } from "./core.mjs";

const labels = {
  topicRelevance: "Topic relevance",
  selectivity: "Selectivity",
  synthesis: "Synthesis",
  coherence: "Coherence",
  nonRepetition: "Non-repetition",
  specificity: "Specificity",
  groundedness: "Groundedness",
  attributionDiscipline: "Attribution discipline",
  readability: "Readability",
  evidenceEconomy: "Evidence economy"
};

function percent(value) {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function ms(value) {
  return value == null ? "n/a" : `${value.toLocaleString()} ms`;
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function counts(value = {}) {
  return Object.entries(value).map(([key, count]) => `${key}: ${count}`).join(", ") || "none";
}

function rejectionSummary(environment) {
  return {
    availableRuns: environment.rejectionDiagnosticsAvailableRuns ?? 0,
    count: environment.rejectionCount ?? 0,
    affectedRuns: environment.runsWithRejections ?? 0,
    byCategory: environment.rejectionsByCategory || {},
    bySection: environment.rejectionsBySection || {},
    byField: environment.rejectionsByField || {}
  };
}

function classificationLabel(classification) {
  return {
    control_stronger: "control stronger",
    treatment_stronger: "treatment stronger",
    equivalent: "equivalent",
    unresolved: "unresolved"
  }[classification] || classification || "not available";
}

function environmentResultLabel(result) {
  return {
    control: "control stronger",
    treatment: "treatment stronger",
    equivalent: "equivalent",
    unresolved: "unresolved",
    concern: "concern"
  }[result] || result || "not available";
}

function proseMarkdown(label, run) {
  const output = [`#### ${label}${run?.environment ? ` (${run.environment})` : ""}`, ""];
  if (!run) return output.concat("Response was not captured.", "").join("\n");
  for (const section of run.prose?.sections || []) {
    output.push(`##### ${section.eyebrow || section.id}`, "", `**${section.headline}**`, "", section.summary, "", section.detail, "");
    for (const proof of section.proofItems || []) {
      output.push(`**Proof: ${proof.projectName}**`, "", `Relevance: ${proof.relevance}`, "", `Situation: ${proof.situation?.narrative || ""}`, "", `Task: ${proof.task?.narrative || ""}`, "");
      if (proof.actions?.length) output.push("Actions:", "", ...proof.actions.map((item) => `- ${item.action}`), "");
      if (proof.results?.length) output.push("Results:", "", ...proof.results.map((item) => `- ${item.result}`), "");
      output.push(`Summary: ${proof.summary?.narrative || ""}`, "");
    }
  }
  return output.join("\n");
}

function assessmentMarkdown(label, record) {
  const assessment = record?.assessment;
  if (!assessment) return [`#### Independent ${label} assessment`, "", "Assessment unavailable.", ""];
  return [
    `#### Independent ${label} assessment`,
    "",
    `Overall rating: **${assessment.overall.rating}**. Exception: **${assessment.overall.exception ?? "none"}**. Confidence: **${assessment.overall.confidence || assessment.confidence}**.`,
    "",
    `Overall rationale: ${assessment.overall.rationale}`,
    "",
    `Concerns: ${assessment.concerns?.length ? assessment.concerns.map((concern) => `${concern.type}: ${concern.rationale}`).join("; ") : "none"}.`,
    ""
  ];
}

function rate(value) {
  return value || "n/a";
}

function exception(value) {
  return value ?? "none";
}

function arbitrationPlacement(pair) {
  const placement = pair.arbitrationPlacement || {};
  return `strategy ${placement.strategy || "not recorded"}; A = ${pair.mapping?.A || "n/a"}, B = ${pair.mapping?.B || "n/a"}`;
}

export function buildMarkdownReport(bundle) {
  const { metadata, reliability, qualitative, tournament, shortlist = [], runs, sanity } = bundle;
  const lines = [
    "# Portfolio generation evaluation",
    "",
    `Generated: ${metadata.generatedAt}`,
    "",
    `Evaluator flow: \`${metadata.evaluationFlow || metadata.evaluatorFlow || "not recorded"}\``,
    "",
    `Control: \`${metadata.environments.control.id}\``,
    "",
    `Treatment: \`${metadata.environments.treatment.id}\``,
    "",
    `Matrix: ${metadata.topicConfigurationCount} configurations × ${metadata.repetitions} repetitions × 2 environments = ${runs.length} requested generations`,
    "",
    "## Reliability summary",
    "",
    "| Measure | Control | Treatment |",
    "| --- | ---: | ---: |"
  ];
  const control = reliability.byEnvironment.control;
  const treatment = reliability.byEnvironment.treatment;
  const controlRejections = rejectionSummary(control);
  const treatmentRejections = rejectionSummary(treatment);
  lines.push(
    `| Successful captures | ${control.successfulRuns}/${control.runs} | ${treatment.successfulRuns}/${treatment.runs} |`,
    `| Fully generated runs | ${control.fullyGeneratedRuns}/${control.runs} | ${treatment.fullyGeneratedRuns}/${treatment.runs} |`,
    `| Fallback fields | ${control.fallbackFields}/${control.totalFields} (${percent(control.fallbackFieldRate)}) | ${treatment.fallbackFields}/${treatment.totalFields} (${percent(treatment.fallbackFieldRate)}) |`,
    `| Sections with any fallback | ${control.sectionsWithAnyFallback}/${control.totalSections} (${percent(control.fallbackSectionRate)}) | ${treatment.sectionsWithAnyFallback}/${treatment.totalSections} (${percent(treatment.fallbackSectionRate)}) |`,
    `| Fully fallback sections | ${control.fullyFallbackSections}/${control.totalSections} | ${treatment.fullyFallbackSections}/${treatment.totalSections} |`,
    `| Median latency | ${ms(control.latencyMs.median)} | ${ms(treatment.latencyMs.median)} |`,
    `| Latency range | ${ms(control.latencyMs.minimum)} to ${ms(control.latencyMs.maximum)} | ${ms(treatment.latencyMs.minimum)} to ${ms(treatment.latencyMs.maximum)} |`,
    `| p90 latency | ${ms(control.latencyMs.p90)} | ${ms(treatment.latencyMs.p90)} |`,
    ""
  );
  if (reliability.comparison.materialRegression) {
    lines.push(
      "> **Reliability regression detected.** Treatment added " + reliability.comparison.fallbackFieldDifference + ` fallback fields and increased the fallback-field rate by ${percent(reliability.comparison.fallbackRateDifference)}. This does not automatically reject the treatment, but it requires review.`,
      ""
    );
  } else {
    lines.push("No material fallback regression was detected under the configured threshold.", "");
  }
  lines.push(
    `Control generation statuses: ${counts(control.generationStatuses)}.`,
    "",
    `Treatment generation statuses: ${counts(treatment.generationStatuses)}.`,
    "",
    "### Fallback patterns",
    "",
    "| Environment | By section and field | By topic configuration |",
    "| --- | --- | --- |",
    `| Control | ${escapeCell(counts(control.fallbackBySection))} | ${escapeCell(counts(control.fallbackByTopicConfiguration))} |`,
    `| Treatment | ${escapeCell(counts(treatment.fallbackBySection))} | ${escapeCell(counts(treatment.fallbackByTopicConfiguration))} |`,
    ""
  );

  lines.push(
    "## Rejection diagnostics",
    "",
    "Detailed rejected candidates, reasons, and context remain in each run’s `diagnostics.rejections` array in the companion JSON artifact.",
    "",
    "| Environment | Diagnostics available | Rejections | Runs affected | By category | By section | By field |",
    "| --- | ---: | ---: | ---: | --- | --- | --- |",
    `| Control | ${controlRejections.availableRuns}/${control.runs} | ${controlRejections.count} | ${controlRejections.affectedRuns} | ${escapeCell(counts(controlRejections.byCategory))} | ${escapeCell(counts(controlRejections.bySection))} | ${escapeCell(counts(controlRejections.byField))} |`,
    `| Treatment | ${treatmentRejections.availableRuns}/${treatment.runs} | ${treatmentRejections.count} | ${treatmentRejections.affectedRuns} | ${escapeCell(counts(treatmentRejections.byCategory))} | ${escapeCell(counts(treatmentRejections.bySection))} | ${escapeCell(counts(treatmentRejections.byField))} |`,
    ""
  );
  if (controlRejections.availableRuns < control.runs || treatmentRejections.availableRuns < treatment.runs) {
    lines.push(
      "> Rejection-diagnostics coverage is incomplete. Treat missing diagnostics as unavailable, not as zero rejections.",
      ""
    );
  }

  lines.push("## Qualitative summary", "");
  if (!qualitative) {
    lines.push("Qualitative evaluation was not run. The JSON artifact retains all captured generations for later evaluation.", "");
  } else {
    const excluded = qualitative.excludedPairs || {};
    lines.push(
      `Eligible generated-vs-generated pairs: ${qualitative.comparablePairs}.`,
      `Excluded from prose-quality comparison: ${counts(excluded)}.`,
      "",
      "| Criterion | Control stronger | Treatment stronger | Equivalent | Unresolved | Concern |",
      "| --- | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const criterion of CRITERIA) {
      const result = qualitative.criteria[criterion] || {};
      lines.push(`| ${labels[criterion]} | ${result.control || 0} | ${result.treatment || 0} | ${result.equivalent || 0} | ${result.unresolved || 0} | ${result.concern || 0} |`);
    }
    const overall = qualitative.overall || {};
    lines.push(
      "",
      `Final pair classification: control stronger ${overall.control_stronger || 0}; treatment stronger ${overall.treatment_stronger || 0}; equivalent ${overall.equivalent || 0}; unresolved ${overall.unresolved || 0}.`,
      "",
      `Grounding or attribution concerns by affected environment: control ${qualitative.concerns.control}, treatment ${qualitative.concerns.treatment}.`,
      "",
      `Evaluator confidence: ${counts(qualitative.confidence)}.`,
      "",
      `Arbitration required: ${qualitative.arbitrationRequiredCount || 0}. Arbitration instability: ${qualitative.arbitrationInstabilityCount || 0}.`,
      ""
    );
    lines.push(
      "### Independent rating distributions",
      "",
      "| Rating | Count |",
      "| ---: | ---: |",
      ...[1, 2, 3, 4, 5].map((rating) => `| ${rating} | ${qualitative.ratingDistribution?.[rating] || 0} |`),
      "",
      "Overall rating distribution:",
      "",
      "| Rating | Count |",
      "| ---: | ---: |",
      ...[1, 2, 3, 4, 5].map((rating) => `| ${rating} | ${qualitative.overallRatingDistribution?.[rating] || 0} |`),
      "",
      `Exception counts: concern ${qualitative.exceptionCounts?.concern || 0}; unclear ${qualitative.exceptionCounts?.unclear || 0}.`,
      `Overall exception counts: concern ${qualitative.overallExceptionCounts?.concern || 0}; unclear ${qualitative.overallExceptionCounts?.unclear || 0}.`,
      "",
      "| Criterion | 1 | 2 | 3 | 4 | 5 | Concern | Unclear |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const criterion of CRITERIA) {
      const scores = qualitative.criterionScoreDistributions?.[criterion] || {};
      const exceptions = qualitative.criterionExceptionCounts?.[criterion] || {};
      lines.push(`| ${labels[criterion]} | ${scores[1] || 0} | ${scores[2] || 0} | ${scores[3] || 0} | ${scores[4] || 0} | ${scores[5] || 0} | ${exceptions.concern || 0} | ${exceptions.unclear || 0} |`);
    }
    lines.push(
      "",
      "| Environment | 1 | 2 | 3 | 4 | 5 |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      `| Control | ${qualitative.environmentScoreDistributions?.control?.[1] || 0} | ${qualitative.environmentScoreDistributions?.control?.[2] || 0} | ${qualitative.environmentScoreDistributions?.control?.[3] || 0} | ${qualitative.environmentScoreDistributions?.control?.[4] || 0} | ${qualitative.environmentScoreDistributions?.control?.[5] || 0} |`,
      `| Treatment | ${qualitative.environmentScoreDistributions?.treatment?.[1] || 0} | ${qualitative.environmentScoreDistributions?.treatment?.[2] || 0} | ${qualitative.environmentScoreDistributions?.treatment?.[3] || 0} | ${qualitative.environmentScoreDistributions?.treatment?.[4] || 0} | ${qualitative.environmentScoreDistributions?.treatment?.[5] || 0} |`,
      ""
    );
    const audit = qualitative.positionBiasAudit;
    if (audit) {
      const position = audit.byPresentedPosition || {};
      const environment = audit.byEnvironmentPlacement || {};
      lines.push(
        "### Position-bias audit",
        "",
        `Arbitration passes retained: ${audit.arbitrationPassCount || 0}. Original arbitration passes: ${audit.arbitrationCompletedCount || 0}.`,
        "",
        "| Presented position | Appeared | Wins | Equivalent | Unresolved | Win rate when presented |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
        `| A | ${position.A?.appeared || 0} | ${position.A?.wins || 0} | ${position.A?.equivalent || 0} | ${position.A?.unresolved || 0} | ${percent(position.A?.appeared ? position.A.wins / position.A.appeared : null)} |`,
        `| B | ${position.B?.appeared || 0} | ${position.B?.wins || 0} | ${position.B?.equivalent || 0} | ${position.B?.unresolved || 0} | ${percent(position.B?.appeared ? position.B.wins / position.B.appeared : null)} |`,
        "",
        "| Environment placement | Appeared as A | Appeared as B | Wins as A | Wins as B |",
        "| --- | ---: | ---: | ---: | ---: |",
        `| Control | ${environment.control?.asA || 0} | ${environment.control?.asB || 0} | ${environment.control?.winsAsA || 0} | ${environment.control?.winsAsB || 0} |`,
        `| Treatment | ${environment.treatment?.asA || 0} | ${environment.treatment?.asB || 0} | ${environment.treatment?.winsAsA || 0} | ${environment.treatment?.winsAsB || 0} |`,
        ""
      );
    }
    if (qualitative.mirrorAudit) {
      lines.push(
        `Mirrored-arbitration audit: ${qualitative.mirrorAudit.evaluatedPairs} pairs evaluated in both orientations; ${qualitative.mirrorAudit.positionSensitivePairs} unstable overall results; ${qualitative.mirrorAudit.exactAgreementPairs} exact agreements across the overall judgment and every criterion; ${qualitative.mirrorAudit.pairsWithCriterionDisagreement} pairs with at least one criterion disagreement.`,
        ""
      );
    }
  }
  if (sanity) {
    lines.push(
      "## Control-vs-control sanity check",
      "",
      `Mirrored arbitration completed: ${sanity.mirroredEvaluationCompleted ? `yes (${sanity.mirroredPairs} pairs)` : "no unresolved pairs required mirrored arbitration"}.`,
      ...(sanity.positionSensitivePairs == null ? [] : [`Position-sensitive overall results: ${sanity.positionSensitivePairs}/${sanity.mirroredPairs}.`]),
      "",
      `Randomized mapping reasonably balanced: ${sanity.mappingIsReasonablyBalanced ? "yes" : "no"} (control as A ${sanity.controlAsA}, control as B ${sanity.controlAsB}).`,
      "",
      `Position-bias audit evaluated: ${sanity.positionBiasEvaluated ? "yes" : "no arbitration decisions were available"}.`,
      `Obvious A/B position bias detected: ${sanity.obviousPositionBias == null ? "not evaluated because the qualitative pass was not run" : sanity.obviousPositionBias ? "yes" : "no"}.`,
      ...(sanity.positionBiasPValue == null ? [] : [`Two-sided exact binomial p-value for the blind-position split: ${sanity.positionBiasPValue.toFixed(4)} (${sanity.decisiveComparisons} decisive arbitration comparisons).`]),
      ""
    );
  }

  lines.push("## Relative-quality tournament", "");
  if (!tournament?.summary) {
    lines.push("The relative tournament was not run. No tournament ranking is available.", "");
  } else {
    const summary = tournament.summary;
    const controlPlacement = summary.placement?.control || {};
    const treatmentPlacement = summary.placement?.treatment || {};
    lines.push(
      `Regression interpretation: **Treatment ${summary.interpretation}.** This is decision support, not a final editorial verdict.`,
      "",
      `${tournament.method}. ${tournament.caveat}`,
      "",
      `Evaluator: \`${tournament.evaluatorModel || "not recorded"}\`. API attempts: ${tournament.usage?.calls || 0}; successful judgments: ${tournament.usage?.successfulCalls ?? tournament.usage?.calls ?? 0}; failed attempts: ${tournament.usage?.failedAttempts || 0}. Pairwise comparisons: ${summary.comparisonCount}; decisive: ${summary.decisiveComparisonCount}; mirrored: ${summary.mirroredComparisons}; unstable: ${summary.unstableComparisons?.length || 0}.`,
      "",
      "| Indicator | Control | Treatment |",
      "| --- | ---: | ---: |",
      `| Cohort winners | ${controlPlacement.first || 0} | ${treatmentPlacement.first || 0} |`,
      `| Direct head-to-head wins | ${summary.directWins?.control || 0} | ${summary.directWins?.treatment || 0} |`,
      `| Mean rank | ${summary.rankStatistics?.control?.mean?.toFixed?.(2) ?? "n/a"} | ${summary.rankStatistics?.treatment?.mean?.toFixed?.(2) ?? "n/a"} |`,
      `| Median rank | ${summary.rankStatistics?.control?.median ?? "n/a"} | ${summary.rankStatistics?.treatment?.median ?? "n/a"} |`,
      `| Top-2 placements | ${controlPlacement.top2 || 0} | ${treatmentPlacement.top2 || 0} |`,
      `| Top-3 placements | ${controlPlacement.top3 || 0} | ${treatmentPlacement.top3 || 0} |`,
      `| Bottom placements | ${controlPlacement.bottom || 0} | ${treatmentPlacement.bottom || 0} |`,
      "",
      `Direct treatment win rate: ${percent(summary.directTreatmentWinRate)} across ${summary.directControlTreatmentComparisons} control-vs-treatment comparisons.`,
      `Margins: ${counts(summary.margins)}. Confidence: ${counts(summary.confidence)}.`,
      `A-vs-B pass wins: A ${summary.positionBias?.allPasses?.A || 0}, B ${summary.positionBias?.allPasses?.B || 0}, across ${summary.positionBias?.allPasses?.total || 0} original and mirrored judgments. Unstable mirror rate: ${percent(summary.positionBias?.unstableMirrorRate)}. Suspicious position sensitivity flagged: ${summary.positionBias?.suspicious ? "yes" : "no"}.`,
      `Evaluator-error comparisons: ${summary.evaluatorErrors?.length || 0}.`,
      `Substantial treatment losses: ${summary.substantialTreatmentLosses?.length || 0}. Treatment-bottom cohorts: ${summary.treatmentBottomTopics?.join(", ") || "none"}. Repeated-regression cohorts: ${summary.repeatedTreatmentRegressions?.join(", ") || "none"}.`,
      ""
    );
    for (const cohort of tournament.cohorts || []) {
      lines.push(
        `### ${cohort.topicConfiguration.label}`,
        "",
        "| Rank | Candidate | Environment | W | L | Unresolved | Relative strength |",
        "| ---: | --- | --- | ---: | ---: | ---: | ---: |"
      );
      for (const candidate of cohort.ranking || []) {
        lines.push(`| ${candidate.rank} | ${candidate.environment === "control" ? "Control" : "Treatment"} rep ${candidate.repetition} | ${candidate.environment} | ${candidate.wins} | ${candidate.losses} | ${candidate.unresolved} | ${candidate.relativeStrength.toFixed(3)} |`);
      }
      lines.push("");
    }
    if (tournament.humanReviewShortlist?.length) {
      lines.push(
        "### Tournament comparisons for manual review",
        "",
        "| Cohort | Comparison | Reason |",
        "| --- | --- | --- |",
        ...tournament.humanReviewShortlist.map((item) => `| ${escapeCell(item.cohortId)} | \`${item.comparisonId}\` | ${escapeCell(item.reason)} |`),
        ""
      );
    }
  }

  lines.push("## Cases Ben should review", "");
  if (!shortlist.length) lines.push("No qualitative shortlist is available yet.", "");
  const runMap = new Map(runs.map((run) => [run.runId, run]));
  shortlist.forEach((item, index) => {
    const pair = item.pair;
    const controlRun = runMap.get(pair.controlRunId) || runMap.get(pair.blind?.A);
    const treatmentRun = runMap.get(pair.treatmentRunId) || runMap.get(pair.blind?.B);
    const deterministic = item.deterministicComparison;
    const final = item.final || {};
    lines.push(
      `### ${index + 1}. ${pair.topicConfigurationLabel}, repetition ${pair.repetition}`,
      "",
      `Why shortlisted: ${item.shortlistReasons?.join(", ") || "representative comparison"}.`,
      "",
      `Final pair classification: **${classificationLabel(final.classification)}**. Confidence: **${final.confidence || "not recorded"}**.`,
      "",
      `Deterministic comparison: **${classificationLabel(deterministic?.classification)}**. ${deterministic?.reason || "Not recorded."}`,
      "",
      `Arbitration required: ${item.arbitrationRequired ? "yes" : "no"}.`,
      ""
    );
    if (item.arbitration) {
      lines.push(
        `Arbitration placement: ${arbitrationPlacement(pair)}.`,
        "",
        `Arbitration result before mapping: **${item.arbitration.judgment.overall.judgment}**.`,
        "",
        `Arbitration result after mapping: **${environmentResultLabel(item.arbitration.unblinded.overall.environmentResult)}**.`,
        ""
      );
    }
    if (item.mirrorAudit) {
      lines.push(
        `Instability flag: ${item.mirrorAudit.positionSensitive ? "unstable, result changed with A/B placement" : "stable overall result across mirrored placement"}.`,
        "",
        `Mirrored arbitration outcomes: original ${item.mirrorAudit.originalOverall}; mirrored ${item.mirrorAudit.mirroredOverall}.`,
        "",
        `Criterion disagreements: ${item.mirrorAudit.criterionDisagreements.length ? item.mirrorAudit.criterionDisagreements.map((criterion) => labels[criterion]).join(", ") : "none"}.`,
        ""
      );
    }
    lines.push(
      ...assessmentMarkdown("control", item.independentAssessments?.control),
      ...assessmentMarkdown("treatment", item.independentAssessments?.treatment),
      "| Criterion | Control rating | Control exception | Control confidence | Control rationale | Treatment rating | Treatment exception | Treatment confidence | Treatment rationale | Difference | Deterministic comparison | Final result |",
      "| --- | ---: | --- | --- | --- | ---: | --- | --- | --- | ---: | --- | --- |",
      ...CRITERIA.map((criterion) => {
        const comparison = deterministic?.criteria?.[criterion] || {};
        const finalCriterion = final.criteria?.[criterion] || {};
        return `| ${labels[criterion]} | ${rate(comparison.controlRating)} | ${exception(comparison.controlException)} | ${rate(comparison.controlConfidence)} | ${escapeCell(comparison.controlRationale || "n/a")} | ${rate(comparison.treatmentRating)} | ${exception(comparison.treatmentException)} | ${rate(comparison.treatmentConfidence)} | ${escapeCell(comparison.treatmentRationale || "n/a")} | ${comparison.ratingDifference ?? "n/a"} | ${classificationLabel(comparison.result)} | ${environmentResultLabel(finalCriterion.environmentResult)} |`;
      }),
      "",
      proseMarkdown("Control response", controlRun),
      "",
      proseMarkdown("Treatment response", treatmentRun),
      ""
    );
  });
  lines.push(
    "## Raw results",
    "",
    qualitative
      ? "The companion JSON artifact contains every request mapping, independent control and treatment assessment, deterministic comparison, arbitration request and response when required, tournament pairwise judgment and placement mapping, diagnostic field, evaluator response, and final classification. No source prose was discarded."
      : "The companion JSON artifact contains every request mapping, response payload, diagnostic field, and source prose. Qualitative evaluator records will be added when that pass runs. No source prose was discarded.",
    ""
  );
  return lines.join("\n");
}
