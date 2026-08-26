# MTI-1 agent guidance

- Preserve the evidence-grounded generation boundary.
- Treat `src/content/mti-1-content-packet.json` as the only approved professional knowledge source for MTI-1.
- Distinguish sourced facts from interpretation.
- Preserve attribution and visibility rules as the content schema evolves.
- Use Astryx with the Neutral theme as the default design system.
- Never expose `OPENAI_API_KEY` or other server secrets to client code.
- Run `npm test` and `npm run build` before proposing deployment.
- Do not deploy or change production environment variables without explicit approval.
