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

function proseMarkdown(label, run) {
  const output = [`#### ${label} (${run.environment})`, ""];
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

export function buildMarkdownReport(bundle) {
  const { metadata, reliability, qualitative, shortlist = [], runs, sanity } = bundle;
  const lines = [
    "# Portfolio generation evaluation",
    "",
    `Generated: ${metadata.generatedAt}`,
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

  lines.push("## Qualitative summary", "");
  if (!qualitative) {
    lines.push("Qualitative evaluation was not run. The JSON artifact retains all captured generations for later evaluation.", "");
  } else {
    lines.push(`Comparable pairs: ${qualitative.comparablePairs}.`, "", "| Criterion | Treatment stronger | Control stronger | Equivalent | Concern | Low confidence |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const criterion of CRITERIA) {
      const result = qualitative.criteria[criterion] || {};
      lines.push(`| ${labels[criterion]} | ${result.treatment || 0} | ${result.control || 0} | ${result.equivalent || 0} | ${result.concern || 0} | ${result.low_confidence || 0} |`);
    }
    lines.push(
      "",
      `Overall: ${counts(qualitative.overall)}.`,
      "",
      `Grounding or attribution concerns by affected environment: control ${qualitative.concerns.control}, treatment ${qualitative.concerns.treatment}.`,
      "",
      `Evaluator confidence: ${counts(qualitative.confidence)}.`,
      "",
      `Blind-position audit: control appeared as A ${qualitative.blindPosition.controlAsA} times and B ${qualitative.blindPosition.controlAsB} times. A won ${qualitative.blindPosition.aOverallWins} decisive comparisons and B won ${qualitative.blindPosition.bOverallWins}.`,
      ""
    );
    if (qualitative.mirrorAudit) {
      lines.push(
        `Mirrored-pass audit: ${qualitative.mirrorAudit.evaluatedPairs} pairs evaluated in both orientations; ${qualitative.mirrorAudit.positionSensitivePairs} position-sensitive overall results; ${qualitative.mirrorAudit.exactAgreementPairs} exact agreements across the overall judgment and every criterion; ${qualitative.mirrorAudit.pairsWithCriterionDisagreement} pairs with at least one criterion disagreement.`,
        ""
      );
    }
  }
  if (sanity) {
    lines.push(
      "## Control-vs-control sanity check",
      "",
      `Mirrored qualitative evaluation completed: ${sanity.mirroredEvaluationCompleted ? `yes (${sanity.mirroredPairs} pairs)` : "no"}.`,
      ...(sanity.positionSensitivePairs == null ? [] : [`Position-sensitive overall results: ${sanity.positionSensitivePairs}/${sanity.mirroredPairs}.`]),
      "",
      `Randomized mapping reasonably balanced: ${sanity.mappingIsReasonablyBalanced ? "yes" : "no"} (control as A ${sanity.controlAsA}, control as B ${sanity.controlAsB}).`,
      "",
      `Obvious A/B position bias detected: ${sanity.obviousPositionBias == null ? "not evaluated because the qualitative pass was not run" : sanity.obviousPositionBias ? "yes" : "no"}.`,
      ...(sanity.positionBiasPValue == null ? [] : [`Two-sided exact binomial p-value for the blind-position split: ${sanity.positionBiasPValue.toFixed(4)} (${sanity.decisiveComparisons} decisive comparisons).`]),
      ""
    );
  }
  lines.push("## Cases Ben should review", "");
  if (!shortlist.length) lines.push("No qualitative shortlist is available yet.", "");
  const runMap = new Map(runs.map((run) => [run.runId, run]));
  shortlist.forEach((item, index) => {
    const pair = item.pair;
    const a = runMap.get(pair.blind.A);
    const b = runMap.get(pair.blind.B);
    lines.push(
      `### ${index + 1}. ${pair.topicConfigurationLabel}, repetition ${pair.repetition}`,
      "",
      `Why shortlisted: ${item.shortlistReasons.join(", ") || "representative comparison"}.`,
      "",
      `Mapping after evaluation: A = ${pair.mapping.A}, B = ${pair.mapping.B}.`,
      "",
      `Evaluator conclusion: ${item.judgment.overall.rationale}`,
      "",
      `Overall judgment: ${item.judgment.overall.judgment}. Confidence: ${item.judgment.confidence}.`,
      "",
      ...(item.mirrorAudit ? [
        `Mirrored evaluation: ${item.mirrorAudit.positionSensitive ? "position-sensitive overall result" : "overall result consistent across orientations"}. Original orientation resolved to ${item.mirrorAudit.originalOverall}; mirrored orientation resolved to ${item.mirrorAudit.mirroredOverall}.`,
        "",
        `Criterion disagreements: ${item.mirrorAudit.criterionDisagreements.length ? item.mirrorAudit.criterionDisagreements.map((criterion) => labels[criterion]).join(", ") : "none"}.`,
        "",
        `Original-pass rationale: ${item.evaluatorPasses.original.judgment.overall.rationale}`,
        "",
        `Mirrored-pass rationale: ${item.evaluatorPasses.mirrored.judgment.overall.rationale}`,
        ""
      ] : []),
      "| Criterion | Judgment | Rationale |",
      "| --- | --- | --- |",
      ...CRITERIA.map((criterion) => `| ${labels[criterion]} | ${item.judgment.criteria[criterion].judgment} | ${escapeCell(item.judgment.criteria[criterion].rationale)} |`),
      "",
      proseMarkdown("Response A", a),
      "",
      proseMarkdown("Response B", b),
      ""
    );
  });
  lines.push(
    "## Raw results",
    "",
    qualitative
      ? "The companion JSON artifact contains every request mapping, response payload, diagnostic field, evaluator request, evaluator response, and unblinded judgment. No source prose was discarded."
      : "The companion JSON artifact contains every request mapping, response payload, diagnostic field, and source prose. Qualitative evaluator records will be added when that pass runs. No source prose was discarded.",
    ""
  );
  return lines.join("\n");
}
