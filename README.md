# Productively Disruptive — MTI-1

The first testable vertical slice of Ben Shectman’s generative professional portfolio. Visitors choose the topics that matter to them and receive a sequenced portfolio narrative grounded in a bounded evidence corpus.

## Experience

- Configures one locked renderer: Astryx with the Neutral theme.
- Supports optional multi-select topics: Design Leadership, Systems Thinking, Enterprise UX, and UX Measurement.
- Renders a balanced experience when no topics are selected.
- Produces four semantic narrative sections, an inline “Tell me more” disclosure, and a focused Establish → Prove → Scale → Institutionalize deep dive.
- Preserves visitor configuration and disclosure history in React state.
- Never renders model-authored HTML or design-system markup.

## Content boundary

`src/content/mti-1-content-packet.json` is the only approved professional knowledge source for MTI-1. Typed access and reference validation live in `src/content/content.ts`. Deterministic selection and narrative assembly live in `src/shared/narrative.ts`.

Knowledge-only source artifacts may ground server-side framing but their metadata and raw source contents are never returned to the browser. Client-visible evidence contains only the approved claim, evidence ID, attribution, and topic references.

### BenFacts migration candidates

The earlier Ben-GPT profile is preserved under `src/content/legacy/`. The expanded review corpus is `src/content/candidates/ben-facts-migration.v0.2.json`: it preserves all 32 migrated records and adds source-derived candidates from the supplied résumé, case studies, launch materials, walking deck, and quarterly reviews. Every record remains pending review and outside the approved MTI-1 packet. See `docs/ben-facts-migration-review.md` for source visibility, evidence strength, attribution, and promotion rules.

## Deterministic mode

The complete experience works without an OpenAI key. Topic overlap and small transparent priority lists select approved evidence, which is assembled into the semantic narrative contract and rendered through Astryx Neutral.

If the generation function is unavailable, unconfigured, times out, encounters a network error, or returns invalid structured output, the client keeps this deterministic narrative without displaying a technical error.

The model-call timeout is temporarily set to 30 seconds to distinguish timeout-driven fallbacks from structured-output validation failures. The sub-10-second experience target is intentionally deferred during this diagnostic period.

## AI-framed mode

When `OPENAI_API_KEY` is configured, the existing Netlify function:

1. validates the locked design system, theme, and topic IDs;
2. deterministically selects relevant approved evidence;
3. assigns only relevant approved evidence to each predetermined narrative section;
4. asks the OpenAI Responses API for a short headline, concise lead, and fuller narrative detail using strict JSON-schema output;
5. validates all generated fields with Zod and targeted grounding checks, then merges them onto immutable deterministic section IDs, purposes, disclosures, and evidence references;
6. returns the bounded semantic narrative or the deterministic fallback.

AI may generate headings, lead paragraphs, narrative detail, emphasis, and connective tissue using only the facts assigned to each section. The server rejects unsupported numbers and aggregated quantitative threshold claims, including the known regression that incorrectly described 114%, 85%, 122%, and a 104-point increase as all exceeding 100%. AI cannot choose section structure, evidence references, disclosure behavior, arbitrary markup, source artifacts, or unvalidated output.

### Reading hierarchy

- **Headline:** a section title, targeting 4–8 words; generated titles are limited to 3–9 words and 64 characters. Paragraph-like, malformed, or unexplained-acronym titles fall back rather than being visually clipped.
- **Lead:** one intact evidence-backed point with brief orientation where needed. The editorial planner's lead paragraphs are tested across all topic combinations to stay within 75 words.
- **Tell me more:** remaining selected context, displayed as readable paragraphs on demand. Every editorial and approved-fallback block supports inline depth, including blocks that also link to the focused deep dive.
- **Evidence behind this:** the separate source-fact inspection dialog; it is not the narrative expansion.

Headlines may use supported abbreviations such as J&J or XD only when the visible lead spells out Johnson & Johnson or Experience Design. The server supplies the eligible abbreviations to the model and checks its output against the same list. Unknown product acronyms are never expanded by guesswork. The source facts themselves remain unchanged.

## Temporary candidate-validation mode

The generation function temporarily defaults `BENFACTS_VALIDATION_MODE` to `candidates`. In this explicit validation mode, deterministic topic selection and optional AI framing use only the sanitized wording, candidate ID, attribution, and topic tags from source-derived records `BF-C-033` through `BF-C-080`.

The browser never receives the candidate manifest, source references, filenames, hashes, internal excerpts, review notes, or evidence-strength rationale. Generated pages and evidence dialogs visibly identify the facts as unapproved validation candidates. The approved four-stage deep dive remains grounded in the approved MTI-1 packet.

Candidate validation uses an editorial planner by default. It creates a stable audience-facing arc—About Ben → Recent Leadership → Proof in Practice → Career Throughline—then selects facts according to section fit, visitor-topic relevance, recency, portfolio salience, evidence strength, and non-repetition. Recent experience provides the center of gravity while earlier roles establish a longer career pattern. Provisional editorial guidance lives separately in the server-only `netlify/functions/candidate-editorial-metadata.ts`; it does not alter the candidate compendium or its approval status.

The previous flat-selection planner remains available as a rollback path. Set the Functions runtime variable `NARRATIVE_PLANNER_MODE=legacy` and redeploy to restore its selection behavior. Set it to `editorial` (or omit it) to use the new planner. Both planners return the same validated semantic narrative contract, and neither gives the model control of evidence selection, section structure, visitor labels, or rendering.

To end the experiment immediately, set `BENFACTS_VALIDATION_MODE=approved` for the Functions runtime in Netlify and redeploy. To end it in code, change the temporary default in `netlify/functions/candidate-validation.ts` from `candidates` to `approved`. The server then returns to the original approved deterministic and AI corpus.

The implementation uses the Responses API `text.format` JSON-schema configuration with strict schema adherence, as described in the [official OpenAI API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## Local development

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Run `npm run dev:netlify` to exercise the UI and function together.

`npm run dev` runs the deterministic UI alone; requests to the absent function fall back automatically.

## Environment variables

- `OPENAI_API_KEY` — optional, server-side only.
- `OPENAI_MODEL` — optional; defaults to `gpt-4.1-mini`.
- `BENFACTS_VALIDATION_MODE` — temporary; defaults to `candidates` (sanitized, unapproved candidate facts). Set explicitly to `approved` to use only the approved packet.
- `NARRATIVE_PLANNER_MODE` — temporary candidate-mode planner switch; `editorial` is the default and `legacy` restores the previous selection behavior.
- `ALLOWED_ORIGINS` — comma-separated exact browser origins.
- `VITE_GENERATE_ENDPOINT` — optional client endpoint override.

## Verification

- `npm test` validates content integrity, reference resolution, selection behavior, contracts, attribution, knowledge-only isolation, and fallback behavior.
- `npm run build` performs TypeScript and production Vite builds.

MTI-1 is intentionally a learning prototype. It does not introduce persistence, authentication, analytics, freeform prompts, job-description uploads, embeddings, vector retrieval, a CMS, or additional renderers/themes.

