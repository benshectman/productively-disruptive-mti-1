# Generation evaluation harness

The evaluation harness is a development-only CLI for comparing portfolio generation behavior between two branch deploys or Netlify Deploy Previews. It does not change the application, generation endpoint, generation prompt, or production deployment behavior.

## What it does

The default matrix covers 11 configurations: no topics, each single topic, four representative pairs, one representative triple, and all topics. Three repetitions per configuration produce 66 generation requests across control and treatment.

For every request, the harness enables `diagnostics=1` and retains the endpoint label, selected topics, repetition, request ID, latency, HTTP and generation status, validation headers, diagnostics, field provenance, prose, proof content, public evidence, and complete raw response. Detailed rejected candidates, reasons, and context remain in each run's `diagnostics.rejections` array.

Before capture, the combined workflow makes a minimal evaluator preflight request containing no portfolio or evidence data. This verifies the API credential, network path, and evaluator model before the 66 generation requests begin.

After capture, the harness atomically writes a `portfolio-generation-capture-*.json` checkpoint before qualitative evaluation starts. For each generated-vs-generated pair, the evaluator first assesses each response independently, without A/B or environment labels. Ordinary code then compares the structured ratings. Only unresolved pairs proceed to blinded arbitration, using a seeded, balanced placement, and results are mapped back to environments only after judging. Sanity mode adds the reversed A/B arbitration pass needed to expose placement instability. Evaluator progress is written back after every pair, so an interrupted run can resume.

Generated-vs-fallback pairs remain reliability events and are excluded from prose-quality comparison. Fallback-vs-fallback pairs are also excluded.

The JSON output is the audit artifact. The Markdown report summarizes reliability, rejection diagnostics by environment/category/section/field, and qualitative comparisons, then includes the full prose for a 5–10 item human-review shortlist. When an endpoint does not support rejection diagnostics, the report marks that coverage as unavailable rather than treating it as zero rejections. Ben remains the final decision-maker.

## Run a comparison

Use branch deploys or Deploy Previews. Do not point either variable at the production site.

```bash
EVAL_CONTROL_URL="https://develop--example.netlify.app" \
EVAL_TREATMENT_URL="https://feature-example--example.netlify.app" \
OPENAI_API_KEY="..." \
npm run eval:harness
```

The request that initiates this command should explicitly authorize sending generated portfolio prose, returned approved evidence, and selected topic configurations to the OpenAI API. The CLI preflight verifies connectivity, but it does not replace user authorization for that data transfer.

Optional labels and evaluator model:

```bash
EVAL_CONTROL_ID="develop@abc123" \
EVAL_TREATMENT_ID="feature/prompt-synthesis-experiment@def456" \
EVAL_MODEL="gpt-4.1-mini" \
npm run eval:harness
```

Results are written to `evaluation-results/` by default. That directory is ignored by Git because raw outputs may be large. API keys are never placed in the report or JSON.

## Capture first, evaluate later

Capture preserves all generation data without using the evaluator model:

```bash
EVAL_CONTROL_URL="..." EVAL_TREATMENT_URL="..." \
npm run eval:capture
```

Evaluate and report a saved capture later:

```bash
OPENAI_API_KEY="..." \
npm run eval:evaluate -- evaluation-results/portfolio-generation-capture-TIMESTAMP.json
```

The evaluation command runs the same preflight, skips every completed evaluator pair, retries incomplete or failed pairs, and continues updating the checkpoint after each pair. `--input FILE` remains available as a backward-compatible alias for `--evaluate-existing FILE`.

Regenerate only the Markdown report from an existing JSON artifact:

```bash
npm run eval:report -- --input evaluation-results/portfolio-generation-evaluation-TIMESTAMP.json
```

## Control-vs-control sanity check

Point both URLs at the same Stage 1 branch deploy, use distinct labels if useful, and add `--sanity`:

```bash
EVAL_CONTROL_URL="https://develop--example.netlify.app" \
EVAL_TREATMENT_URL="https://develop--example.netlify.app" \
EVAL_CONTROL_ID="develop-A" \
EVAL_TREATMENT_ID="develop-B" \
OPENAI_API_KEY="..." \
npm run eval:harness -- --sanity
```

Sanity mode uses the same independent-assessment flow against equivalent endpoints. Any unresolved pair is arbitrated twice, with the second pass reversing A and B. A winner is retained only when both passes select the same underlying generation. If the conclusion changes with presentation order, the final result is unresolved, marked unstable, and prioritized for human review. Both raw passes remain in the JSON audit artifact.

The report shows independent assessments, the deterministic comparison, arbitration placement and outcomes, unstable cases, A/B assignment balance, and a two-sided exact binomial test of arbitration A/B winners. A probability of 0.05 or less is flagged as possible position bias. This is a warning, not proof of bias.

## Configuration

Copy `scripts/evaluation/default-config.json` and pass `--config FILE` to change:

- topic configurations;
- repetition count;
- capture concurrency;
- request timeout or delay;
- endpoint environment-variable names;
- evaluator model environment-variable name;
- material fallback-regression threshold;
- shortlist limits;
- deterministic pairing seed.

The default reliability flag requires both at least two additional treatment fallback fields and at least a one-percentage-point increase in treatment fallback-field rate. A flag is deliberately prominent but never automatically rejects a treatment.

## Interpreting the output

Objective reliability is calculated only from response data and headers. Independent qualitative assessments use strong, adequate, weak, concern, or unclear ratings. Deterministic comparison uses explicit dominance and effective-tie rules, without a weighted composite score. A tied overall rating requires at least three criteria favoring one response and none favoring the other before it is classified as stronger. Final classifications are control stronger, treatment stronger, equivalent, or unresolved.

The evaluator assesses topic relevance, selectivity, synthesis, coherence, non-repetition, specificity, groundedness, attribution discipline, readability, and evidence economy. Its judgments are evidence organization for human review, not an approval decision.
