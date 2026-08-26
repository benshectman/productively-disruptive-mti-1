# Productively Disruptive — MTI-1

The first testable vertical slice of Ben Shectman’s generative professional portfolio. Visitors choose the topics that matter to them and receive a sequenced portfolio narrative grounded exclusively in approved evidence.

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

## Deterministic mode

The complete experience works without an OpenAI key. Topic overlap and small transparent priority lists select approved evidence, which is assembled into the semantic narrative contract and rendered through Astryx Neutral.

If the generation function is unavailable, unconfigured, times out, encounters a network error, or returns invalid structured output, the client keeps this deterministic narrative without displaying a technical error.

## AI-framed mode

When `OPENAI_API_KEY` is configured, the existing Netlify function:

1. validates the locked design system, theme, and topic IDs;
2. deterministically selects relevant approved evidence;
3. assigns only relevant approved evidence to each predetermined narrative section;
4. asks the OpenAI Responses API only for rewritten headlines and summaries using strict JSON-schema output;
5. validates the framing with Zod and merges it onto immutable deterministic section IDs, purposes, disclosures, details, and evidence references;
6. returns the bounded semantic narrative or the deterministic fallback.

AI may vary headings, summaries, transitions, and emphasis. It cannot choose section structure, evidence references, disclosure behavior, arbitrary markup, source artifacts, or unvalidated output.

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

## Verification

- `npm test` validates content integrity, reference resolution, selection behavior, contracts, attribution, knowledge-only isolation, and fallback behavior.
- `npm run build` performs TypeScript and production Vite builds.

MTI-1 is intentionally a learning prototype. It does not introduce persistence, authentication, analytics, freeform prompts, job-description uploads, embeddings, vector retrieval, a CMS, or additional renderers/themes.
