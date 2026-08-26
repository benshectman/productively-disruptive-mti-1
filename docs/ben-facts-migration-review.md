# BenFacts migration review

The Ben-GPT profile is preserved at `src/content/legacy/ben-profile-v0.1-alpha.json`. Its GitHub blob SHA is recorded in the migration manifest so the source can be traced back to the earlier application.

`src/content/candidates/ben-facts-migration.v0.1.json` classifies all 29 profile entries and three chat-policy boundaries. It is deliberately outside the approved MTI-1 packet and is not loaded by the portfolio or sent to OpenAI.

## Classification

| Proposed destination | Count | Intended use |
| --- | ---: | --- |
| Proposition candidates | 3 | About Me positioning that must be supported by approved evidence |
| Evidence candidates | 11 | Atomic professional claims that may eventually receive `E-###` IDs |
| Project candidates | 4 | Seeds for structured selected-work or case-study records |
| Career-record candidates | 5 | Canonical role and chronology records |
| Credential candidates | 2 | Static education and certification content |
| Topic candidates | 4 | Portfolio taxonomy rather than evidence |
| Policy candidates | 3 | Generation and privacy rules rather than professional claims |

## Required review

For each candidate:

1. Identify the authoritative source material.
2. Confirm or correct the original wording.
3. Split compound claims where facts need independent substantiation or reuse.
4. Set attribution: personal, leadership, team, shared leadership, or organization.
5. Set visibility: shareable or knowledge only.
6. Reconcile overlaps with `E-001` through `E-015` and `P-001`.
7. Confirm topic assignments and identify missing topic categories.
8. Promote only reviewed records into the approved packet and then assign stable IDs.

The legacy BenFacts source is classified as `unverified_migration_source`. Prior approval for a chat experience does not by itself establish documentary authority or permission to expose a claim in the portfolio.

## Notable compound candidates

- The design-services portfolio statement combines Ben's role, portfolio value, and engagement count.
- The analytics statement combines two distinct initiatives.
- The certification statement combines three credentials.
- The Pfizer statement combines a named employer with unspecified other roles.

These should be separated or modeled as structured career/project/credential records before approval.
