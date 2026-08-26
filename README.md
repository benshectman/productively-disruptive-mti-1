# Productively Disruptive — MTI-1

A bounded, evidence-grounded portfolio prototype built with React, TypeScript, Vite, Astryx (Neutral), Netlify Functions, and the OpenAI Responses API.

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and provide the required values.
3. Run `npm run dev` for the UI or `npm run dev:netlify` for the UI and function together.

## Environment

- `OPENAI_API_KEY` — server-side only.
- `OPENAI_MODEL` — optional; defaults to `gpt-4.1-mini`.
- `ALLOWED_ORIGINS` — comma-separated exact browser origins.
- `VITE_GENERATE_ENDPOINT` — optional client endpoint override.

## Architecture

- `src/` — React portfolio experience.
- `src/content/` — versioned, approved evidence and generation rules.
- `src/shared/` — request and response contracts shared with the function.
- `netlify/functions/` — server-side OpenAI boundary.
- `tests/` — contract and content validation.

The content schema is deliberately provisional for MTI-1 and should evolve from prototype evidence rather than become a premature platform contract.
