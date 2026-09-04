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

`src/content/approved/ben-facts.v1.json` is the approved professional fact corpus used for deterministic selection, AI framing, runtime evidence, and project-scoped Proof in Practice items. `src/content/mti-1-content-packet.json` remains the approved source for the fixed topic taxonomy and focused four-stage deep dive. Typed approved-corpus adaptation and deterministic planning live in `src/shared/approved-benfacts.ts`.

Knowledge-only source artifacts may ground server-side framing but their metadata and raw source contents are never returned to the browser. Client-visible evidence contains only the approved claim, evidence ID, attribution, and topic references.

### BenFacts governance sources

The earlier Ben-GPT profile and migration candidate files remain under `src/content/legacy/` and `src/content/candidates/` as internal governance inputs. Review state remains in `src/content/review/ben-facts-review.v1.json`. Generation and visitor-facing selection do not import those files; promotion produces the smaller approved `id`/`claim` schema consumed at runtime. See `docs/ben-facts-migration-review.md` for source visibility, evidence strength, attribution, and promotion rules.

### BenFacts Editor

Deploy Preview and `develop` builds expose the internal review route at `/benfacts-editor`. It reads and updates `src/content/review/ben-facts-review.v1.json` through a server-side Netlify Function. Each disposition uses the loaded GitHub SHA to prevent stale writes and creates one descriptive commit on the review branch. The editor route and function are disabled in production builds.

The initial corpus is deterministically normalized from `ben-facts-clean-preapproval-queue.v0.2.json`; all 147 records begin `unreviewed`. Run `npm run benfacts:normalize` to reproduce the review corpus and `npm run benfacts:promote` to generate `src/content/approved/ben-facts.v1.json` from explicitly approved records only.

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

## Approved BenFacts planner

The generation function and browser fallback always use `src/content/approved/ben-facts.v1.json`. The runtime adapter maps approved `id` and `claim` fields onto the deterministic planner while preserving attribution, topics, career context, period, and optional `project_id` project provenance.

The browser receives only the selected approved fact ID, claim, attribution, and topic tags. Source references, filenames, hashes, internal excerpts, review notes, and governance metadata remain outside the public response.

The editorial planner creates a stable audience-facing arc—About Ben → Recent Leadership → Career Throughline → Proof in Practice—then selects approved facts according to section fit, visitor-topic relevance, recency, portfolio salience, and non-repetition. Proof projects are selected before their facts are retrieved, each project is bounded to a deterministic subset, and every mini-STAR proof item is validated against one `project_id` before its 25–45 word summary is rendered.

The model never controls evidence selection, project grouping, section structure, visitor labels, or rendering.

The implementation uses the Responses API `text.format` JSON-schema configuration with strict schema adherence, as described in the [official OpenAI API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## Local development

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Run `npm run dev:netlify` to exercise the UI and function together.

`npm run dev` runs the deterministic UI alone; requests to the absent function fall back automatically.

## Environment variables

- `OPENAI_API_KEY` — optional, server-side only.
- `OPENAI_MODEL` — optional; defaults to `gpt-4.1-mini`.
- `ALLOWED_ORIGINS` — comma-separated exact browser origins.
- `VITE_GENERATE_ENDPOINT` — optional client endpoint override.
- `GITHUB_TOKEN` — required server-side for BenFacts review writes; use a narrowly scoped repository credential.
- `GITHUB_REPO` — repository receiving review commits; defaults to `benshectman/productively-disruptive-mti-1`.
- `BENFACTS_REVIEW_BRANCH` — optional fixed content-review branch. Otherwise the Netlify head branch is used.
- `VITE_ENABLE_BENFACTS_EDITOR` — build-time editor gate. Netlify enables it for Deploy Previews and `develop`, and disables it in production.

## Verification

- `npm test` validates content integrity, reference resolution, selection behavior, contracts, attribution, knowledge-only isolation, BenFacts review and promotion behavior, GitHub conflict protection, and fallback behavior.
- `npm run build` performs TypeScript and production Vite builds.

## Deployment

Routine work targets the persistent `develop` branch and uses Netlify Deploy Previews or its stable branch deploy. `main` is reserved for deliberate production releases, and production builds require a `[release]` marker in the final commit message. See [the deployment workflow](docs/deployment-workflow.md) for setup, testing, and release steps.

MTI-1 is intentionally a learning prototype. It does not introduce persistence, authentication, analytics, freeform prompts, job-description uploads, embeddings, vector retrieval, a CMS, or additional renderers/themes.

