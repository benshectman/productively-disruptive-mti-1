# BenFacts candidate review

The review corpus is `src/content/candidates/ben-facts-migration.v0.2.json`. It contains the 32 records preserved from the earlier Ben-GPT profile plus 48 additional candidates derived from 22 supplied source files.

All 80 records remain candidates. They are outside the approved MTI-1 content packet, are not loaded by the portfolio, and are not sent to OpenAI.

## Source boundary

The résumé and AskGS case study are the only source assets marked shareable. The other 20 files are `knowledge_only`: they may substantiate an approved BenFact, but the application must never expose the file, a download link, internal metadata, raw source contents, or extended excerpts.

A source asset's visibility is separate from a fact's proposed visibility. A private internal artifact can support a public professional claim after Ben approves the claim, its wording, its attribution, and the appropriate level of detail.

## Candidate inventory

| Proposed destination | Count | Intended use |
| --- | ---: | --- |
| Proposition candidates | 4 | About Me positioning grounded in reviewed evidence |
| Evidence candidates | 37 | Professional claims that may eventually receive stable evidence IDs |
| Project candidates | 25 | Structured selected-work or case-study records |
| Career-record candidates | 5 | Canonical role and chronology records |
| Credential candidates | 2 | Static education and certification content |
| Topic candidates | 4 | Portfolio taxonomy rather than evidence |
| Policy candidates | 3 | Generation and privacy rules rather than professional claims |

## Evidence strength

Evidence strength describes support for the proposed wording; it is not a rating of Ben's accomplishment.

| Value | Meaning |
| --- | --- |
| `1 - Poor` | Legacy, ambiguous, inferred, or unsupported by the supplied documentary sources |
| `2 - Fair` | Explicit in one source, but attribution, status, or outcome qualification is weak or ambiguous |
| `3 - Good` | Explicit in a clear authoritative source or strong contemporaneous artifact, but not independently corroborated |
| `4 - Strong` | Explicit and corroborated across relevant artifacts, or a direct primary record with unusually clear authority |

Repeated copies of the same slide or derivative summaries do not automatically count as independent corroboration. Forecasts remain forecasts; directional targets remain targets; and metrics retain their stated baseline, sample, geography, and time-period qualifications.

## Required review

For each candidate:

1. Approve, revise, merge, split, or reject the proposed wording.
2. Confirm the subject and attribution: personal, leadership, team, shared leadership, or organization.
3. Confirm whether the resulting fact may be visitor-visible.
4. Check that every source reference actually supports the complete statement.
5. Preserve qualifications on forecasts, targets, study samples, baselines, and dates.
6. Reconcile overlaps with the current approved evidence and other candidates.
7. Confirm topic assignments and identify missing portfolio topics.
8. Promote only reviewed records into the approved content packet, assigning stable IDs at that point.

Product work delivered by Ben's teams is intentionally written with leadership or team attribution. Directing a body of work does not imply that Ben personally performed every research, design, or implementation activity.

The earlier `v0.1` file remains unchanged as an auditable migration snapshot.
