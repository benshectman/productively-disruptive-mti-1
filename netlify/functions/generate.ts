import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";
import { contentPacket, publicEvidenceView, sourceById } from "../../src/content/content";
import { assembleNarrative, validateNarrativeEvidence } from "../../src/shared/narrative";
import { z } from "zod";
import { GenerateRequestSchema, ProofItemSchema, type GenerationDiagnostics, type GenerationSectionDiagnostics, type Narrative, type ProofItem, type TopicId } from "../../src/shared/contracts";
import { deterministicGenerationDiagnostics, summarizeGenerationDiagnostics } from "../../src/shared/generation-diagnostics";
import {
  assembleCandidateNarrative,
  candidateValidationEnabled,
  candidateValidationIds,
  proofItemEvidenceIds,
  publicCandidateEvidence,
  validateNarrativeProofProjects,
  validateProofItemProjectEvidence
} from "./candidate-validation";
import { allowedHeadlineAcronyms, HEADLINE_MAX_CHARACTERS, HEADLINE_MAX_WORDS, HEADLINE_MIN_WORDS, headlineAcronymsAreExplained } from "../../src/shared/narrative-presentation";

const headersFor = (origin: string) => ({ "Content-Type": "application/json", ...(origin ? { "Access-Control-Allow-Origin": origin } : {}), "Vary": "Origin" });
export const GENERATION_TIMEOUT_MS = 30_000;
export type GenerationStatus = "ai" | "missing-api-key" | "upstream-error" | "empty-output" | "invalid-output" | "timeout" | "network-error";
export type ValidationStatus = "schema" | "section-ids" | "headline-acronym" | "numeric-grounding" | "narrative-evidence";
export function allowedOrigin(origin = "", requestHost = "") {
  const allowlist = (process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (allowlist.includes(origin)) return origin;
  if (!origin || !requestHost) return "";
  try {
    return new URL(origin).host.toLowerCase() === requestHost.toLowerCase() ? origin : "";
  } catch {
    return "";
  }
}

const generatedNarrativeJsonSchema = {
  type: "object", additionalProperties: false, required: ["sections"],
  properties: {
    sections: {
      type: "array", minItems: 4, maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "headline", "summary", "detail"],
        properties: {
          id: { type: "string", enum: ["system-behind-design", "operating-model", "proof-to-scale", "institutionalized-capability"] },
          headline: { type: "string", minLength: 8, maxLength: HEADLINE_MAX_CHARACTERS, pattern: "^[A-Za-z][A-Za-z &’',:–—-]*[A-Za-z]$" },
          summary: { type: "string", minLength: 40, maxLength: 900 },
          detail: { type: "string", minLength: 80, maxLength: 1600 }
        }
      }
    }
  }
};

const danglingHeadlineWords = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "the", "to", "with"]);
const GeneratedHeadlineSchema = z.string().min(8).max(HEADLINE_MAX_CHARACTERS)
  .regex(/^[A-Za-z][A-Za-z &’',:–—-]*[A-Za-z]$/, "Generated headlines must use plain English text")
  .refine((headline) => {
    const words = headline.trim().split(/\s+/);
    return words.length >= HEADLINE_MIN_WORDS && words.length <= HEADLINE_MAX_WORDS
      && !danglingHeadlineWords.has(words.at(-1)!.toLowerCase())
      && !/^(He|She)\b/i.test(headline);
  }, "Generated headlines must be concise and complete");
const generatedProseSchema = (minimum: number, maximum: number) => z.string().min(minimum).max(maximum)
  .refine((value) => !/<\/?[A-Za-z][^>]*>|(?:^|\s)(?:#{1,6}|[-*+]\s|```)|\b(?:E-\d{3}|BF-C-\d{3})\b/.test(value),
    "Generated prose must not contain markup or evidence IDs");

const WireFramingSectionSchema = z.object({
  id: z.enum(["system-behind-design", "operating-model", "proof-to-scale", "institutionalized-capability"]),
  headline: z.string(),
  summary: z.string(),
  detail: z.string()
}).strict();
const WireFramingSchema = z.object({ sections: z.array(WireFramingSectionSchema).length(4) }).strict();
const GeneratedSummarySchema = generatedProseSchema(40, 900)
  .refine((value) => value.trim().split(/\s+/).length <= 75, "Generated leads must stay concise");
const GeneratedDetailSchema = generatedProseSchema(80, 1600);

const generatedProofTextSchema = generatedProseSchema(1, 1200);
const GeneratedProofItemSchema = ProofItemSchema.extend({
  relevance: generatedProseSchema(1, 240),
  situation: z.object({
    narrative: generatedProofTextSchema,
    evidence_fact_ids: z.array(z.string()).min(1).max(9)
  }).strict(),
  task: z.object({
    narrative: generatedProofTextSchema,
    evidence_fact_ids: z.array(z.string()).min(1).max(9)
  }).strict(),
  actions: z.array(z.object({
    action: generatedProofTextSchema,
    evidence_fact_ids: z.array(z.string()).min(1).max(9)
  }).strict()).min(1).max(6),
  results: z.array(z.object({
    result: generatedProofTextSchema,
    result_type: z.enum(["business_decision", "financial_impact", "experience_measurement", "delivery_output", "research_output", "adoption_or_reach", "other_documented_outcome"]),
    evidence_fact_ids: z.array(z.string()).min(1).max(9)
  }).strict()).min(1).max(6),
  summary: z.object({
    narrative: generatedProseSchema(1, 600).refine((value) => !/[.!?]\s+\S/.test(value), "Proof summaries must be one sentence")
      .refine((value) => {
        const words = value.trim().split(/\s+/).filter(Boolean).length;
        return words >= 25 && words <= 45;
      }, "Proof summaries must contain 25 to 45 words"),
    evidence_fact_ids: z.array(z.string()).min(1).max(9)
  }).strict()
}).omit({ case_study_asset_id: true }).strict();

function generatedProofItemJsonSchema(fallback: ProofItem) {
  const allowedIds = proofItemEvidenceIds(fallback);
  const evidenceIds = {
    type: "array", minItems: 1, maxItems: 9,
    items: { type: "string", enum: allowedIds }
  };
  const narrativeEvidence = {
    type: "object", additionalProperties: false, required: ["narrative", "evidence_fact_ids"],
    properties: {
      narrative: { type: "string", minLength: 1, maxLength: 1200 },
      evidence_fact_ids: evidenceIds
    }
  };
  return {
    type: "object", additionalProperties: false,
    required: ["project_id", "project_name", "relevance", "situation", "task", "actions", "results", "summary"],
    properties: {
      project_id: { type: "string", enum: [fallback.project_id] },
      project_name: { type: "string", enum: [fallback.project_name] },
      relevance: { type: "string", minLength: 1, maxLength: 240 },
      situation: narrativeEvidence,
      task: narrativeEvidence,
      actions: {
        type: "array", minItems: 1, maxItems: 6,
        items: {
          type: "object", additionalProperties: false, required: ["action", "evidence_fact_ids"],
          properties: {
            action: { type: "string", minLength: 1, maxLength: 1200 },
            evidence_fact_ids: evidenceIds
          }
        }
      },
      results: {
        type: "array", minItems: 1, maxItems: 6,
        items: {
          type: "object", additionalProperties: false, required: ["result", "result_type", "evidence_fact_ids"],
          properties: {
            result: { type: "string", minLength: 1, maxLength: 1200 },
            result_type: { type: "string", enum: ["business_decision", "financial_impact", "experience_measurement", "delivery_output", "research_output", "adoption_or_reach", "other_documented_outcome"] },
            evidence_fact_ids: evidenceIds
          }
        }
      },
      summary: {
        type: "object", additionalProperties: false, required: ["narrative", "evidence_fact_ids"],
        properties: {
          narrative: { type: "string", minLength: 40, maxLength: 600 },
          evidence_fact_ids: evidenceIds
        }
      }
    }
  };
}

function numericTokens(text: string): string[] {
  return text.match(/(?<![A-Za-z])\$?\d[\d,]*(?:\.\d+)?(?:%|\s*percent(?:age points?)?|\s*(?:-| )?points?)?/gi) || [];
}

function normalizedNumericToken(token: string): string {
  return token.toLowerCase().replaceAll(",", "").replace(/[\s-]+/g, "")
    .replace(/percentagepoints?$/, "point").replace(/points?$/, "point").replace(/percent$/, "%");
}

function generatedTextIsGrounded(generatedText: string, evidenceText: string): boolean {
  const evidenceNumbers = new Set(numericTokens(evidenceText).map(normalizedNumericToken));
  const numbersAreGrounded = numericTokens(generatedText)
    .every((token) => evidenceNumbers.has(normalizedNumericToken(token)));
  if (!numbersAreGrounded) return false;

  // Aggregating unlike measures into one threshold claim caused the known SPR
  // distortion (114%, 85%, 122%, and 104 NPS points became "all over 100%").
  // Require quantitative comparisons to remain attached to individual measures.
  const unsupportedAggregate = /\b(all|each|every|both)\b[^.!?]{0,120}\b(over|above|exceed(?:ed|ing)?|more than|greater than|at least)\b[^.!?]{0,30}\d/i;
  return !unsupportedAggregate.test(generatedText);
}

function generatedProseIsGrounded(generated: { summary: string; detail: string }, evidenceText: string): boolean {
  return generatedTextIsGrounded(`${generated.summary} ${generated.detail}`, evidenceText);
}

function proofItemText(item: ProofItem): string {
  return [
    item.relevance,
    item.situation.narrative,
    item.task.narrative,
    ...item.actions.map((action) => action.action),
    ...item.results.map((result) => result.result),
    item.summary.narrative
  ].join(" ");
}

export function applyAiProofItem(value: unknown, fallback: ProofItem, evidenceText: string): ProofItem | null {
  const result = GeneratedProofItemSchema.safeParse(value);
  if (!result.success) return null;
  const generated = { ...result.data, relevance: fallback.relevance };
  if (generated.project_id !== fallback.project_id || generated.project_name !== fallback.project_name) return null;
  const allowedIds = new Set(proofItemEvidenceIds(fallback));
  if (proofItemEvidenceIds(generated).some((id) => !allowedIds.has(id))) return null;
  if (!validateProofItemProjectEvidence(generated) || !generatedTextIsGrounded(proofItemText(generated), evidenceText)) return null;
  return ProofItemSchema.parse(generated);
}

export function applyAiFraming(
  value: unknown,
  fallback: Narrative,
  allowedIds?: Set<string>,
  evidenceTextBySection?: Map<string, string>,
  onReject?: (status: ValidationStatus) => void,
  onProvenance?: (diagnostics: GenerationDiagnostics) => void,
): Narrative | null {
  const result = WireFramingSchema.safeParse(value);
  if (!result.success) { onReject?.("schema"); return null; }
  const framingById = new Map(result.data.sections.map((section) => [section.id, section]));
  if (framingById.size !== fallback.sections.length || fallback.sections.some((section) => !framingById.has(section.id as typeof result.data.sections[number]["id"]))) {
    onReject?.("section-ids"); return null;
  }
  const provenance: Array<{ id: string; fields: GenerationSectionDiagnostics["fields"] }> = [];
  const narrative: Narrative = {
    mode: "ai",
    grounding: fallback.grounding,
    sections: fallback.sections.map((section) => {
      const framing = framingById.get(section.id as typeof result.data.sections[number]["id"])!;
      const summaryResult = GeneratedSummarySchema.safeParse(framing.summary);
      const detailResult = GeneratedDetailSchema.safeParse(framing.detail);
      const summary = summaryResult.success ? summaryResult.data : section.summary;
      const detail = detailResult.success ? detailResult.data : section.detail;
      const headlineResult = GeneratedHeadlineSchema.safeParse(framing.headline);
      const headlineIsAi = headlineResult.success && headlineAcronymsAreExplained(headlineResult.data, summary);
      const headline = headlineIsAi
        ? framing.headline
        : section.headline;
      provenance.push({ id: section.id, fields: {
        headline: headlineIsAi ? "ai" : "fallback",
        summary: summaryResult.success ? "ai" : "fallback",
        detail: detailResult.success ? "ai" : "fallback"
      } });
      return { ...section, headline, summary, detail };
    })
  };
  if (evidenceTextBySection && narrative.sections.some((section) => !generatedProseIsGrounded(
    { summary: section.summary, detail: section.detail || "" }, evidenceTextBySection.get(section.id) || ""
  ))) { onReject?.("numeric-grounding"); return null; }
  if (!validateNarrativeEvidence(narrative, allowedIds)) { onReject?.("narrative-evidence"); return null; }
  onProvenance?.(summarizeGenerationDiagnostics(provenance));
  return narrative;
}

async function requestStructured(fetcher: typeof fetch, signal: AbortSignal, body: Record<string, unknown>): Promise<unknown | null> {
  try {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) return null;
    const result = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const output = result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim();
    return output ? JSON.parse(output) : null;
  } catch {
    return null;
  }
}

function constrainedEvidence(fallback: Narrative) {
  const relevantIds = new Set(fallback.sections.flatMap((section) => section.evidenceRefs));
  if (fallback.grounding === "candidate_validation") return publicCandidateEvidence(relevantIds);
  return contentPacket.evidence.filter((record) => relevantIds.has(record.id)).map((record) => ({
    ...publicEvidenceView(record),
    sourceAuthority: [...new Set(record.sources.map((id) => sourceById.get(id)?.authority).filter(Boolean))]
  }));
}

export async function generateNarrativeWithStatus(topics: TopicId[], fetcher: typeof fetch = fetch, requestId = "local"):
Promise<{ narrative: Narrative; status: GenerationStatus; diagnostics: GenerationDiagnostics; upstreamStatus?: number; validationStatus?: ValidationStatus }> {
  const useCandidates = candidateValidationEnabled();
  const fallback = useCandidates ? assembleCandidateNarrative(topics) : assembleNarrative(topics);
  const fallbackDiagnostics = deterministicGenerationDiagnostics(fallback);
  const allowedIds = useCandidates ? candidateValidationIds : undefined;
  if (!process.env.OPENAI_API_KEY) return { narrative: fallback, status: "missing-api-key", diagnostics: fallbackDiagnostics };
  const evidence = constrainedEvidence(fallback);
  const evidenceTextBySection = new Map(fallback.sections.map((section) => [
    section.id,
    evidence.filter((item) => section.evidenceRefs.includes(item.id)).map((item) => item.claim).join(" ")
  ]));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  try {
    const framingRequest = fetcher("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini", store: false, max_output_tokens: 2800,
        instructions: [
          "Write the headline, concise lead, and fuller detail for four sections of one continuous professional portfolio narrative.",
          "Return every supplied section ID exactly once. Do not change the section structure or add sections.",
          "Follow the supplied narrative arc in order: establish Ben's career-wide identity, move into recent leadership, connect it to the longer career throughline, then introduce topic-relevant proof in practice.",
          "Make the sequence of headlines build from broad identity to recent leadership, career continuity, and proof. Do not repeat the same claim or construction.",
          useCandidates
            ? "This is an explicitly labeled validation run using unapproved candidate BenFacts. Use only the candidate facts assigned to each section; do not imply that they have been approved."
            : "Use only the approved proposition and evidence assigned to each section.",
          "Preserve every record's attribution. Never turn shared or organizational work into Ben's personal execution.",
          "Do not invent accomplishments, metrics, dates, product descriptions, acronym expansions, or propositions.",
          "Do not add a number unless that exact number appears in the evidence assigned to that section. Preserve its unit and the measure it describes.",
          "Never combine multiple measurements into a shared threshold or range. State each cited metric separately. For example, do not claim that all improvements exceeded 100% when one assigned improvement is 85%.",
          "Do not infer causation or documentary corroboration beyond the assigned evidence.",
          "Claims supported only by first_person_attestation must not be described as independently documented.",
          "Make each lead a connected introduction of no more than 75 words. Make each detail add context and supporting examples rather than repeating the lead or concatenating facts.",
          "Make transitions across sections feel intentional, but do not add facts from one section to another.",
          "For Proof in practice, write only general section framing. Do not mention, combine, or summarize any project-specific work, actions, outcomes, or metrics; separate project-scoped proof items are generated independently.",
          "Name the section's main idea in the headline. Do not try to summarize every supporting point in the title. Do not begin with He, She, or Ben.",
          "Target four to eight words, with a hard limit of three to nine words and sixty-four characters. Use a complete plain-English phrase; do not end with a preposition, conjunction, or article.",
          "Acronyms are welcome only when listed in that section's allowedAcronyms. Their supported expansions already appear in its visible lead paragraph. Do not expand them in the title or invent other abbreviations.",
          "Style example only, not a claim to reuse: Establishing and scaling J&J's XD organization.",
          "Do not put metrics, dates, numbers, HTML, Markdown, evidence IDs, attribution fields, disclosure choices, or design-system markup in headlines. Do not put HTML, Markdown, evidence IDs, or markup in any generated field."
        ].join(" "),
        input: JSON.stringify({
          selectedTopics: topics,
          groundingMode: fallback.grounding,
          approvedProposition: useCandidates ? undefined : contentPacket.propositions[0].statement,
          sections: fallback.sections.map((section) => ({
            id: section.id,
            audienceLabel: section.eyebrow,
            fallbackLead: section.summary,
            fallbackDetail: section.detail,
            allowedAcronyms: allowedHeadlineAcronyms(section.summary),
            narrativeRole: section.id === "system-behind-design" ? "career-wide orientation"
              : section.id === "operating-model" ? "recent leadership and organizational scale"
              : section.id === "proof-to-scale" ? "topic-relevant projects and outcomes"
              : "connection to earlier career experience",
            evidence: section.id === "proof-to-scale" ? [] : evidence.filter((item) => section.evidenceRefs.includes(item.id))
          }))
        }),
        text: { format: { type: "json_schema", name: "portfolio_narrative", strict: true, schema: generatedNarrativeJsonSchema } }
      })
    });

    const fallbackProofItems = fallback.sections.find((section) => section.id === "proof-to-scale")?.proof_items || [];
    const proofRequests = useCandidates ? fallbackProofItems.map((item) => {
      const projectEvidence = evidence.filter((record) => proofItemEvidenceIds(item).includes(record.id));
      return requestStructured(fetcher, controller.signal, {
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini", store: false, max_output_tokens: 1800,
        instructions: [
          "Generate one mini-STAR evidence model for exactly one professional project.",
          "Use only the supplied evidence, which has already been restricted to one project_id. Do not use knowledge from any other project.",
          "Return the supplied project_id and project_name unchanged. Preserve the supplied relevance unless a shorter equivalent is needed.",
          "Every narrative, action, result, and summary must cite one or more supplied evidence_fact_ids. A fact may support more than one STAR field when the source is compact.",
          "Preserve attribution exactly. Never turn team, shared-leadership, or organizational work into Ben's personal execution.",
          "Do not invent accomplishments, actions, outcomes, metrics, dates, product descriptions, acronym expansions, causation, or corroboration.",
          "Do not add a number unless that exact number appears in the supplied evidence. Preserve its unit and the measure it describes.",
          "Never combine unlike measurements into one threshold or range. State each metric with its own measure.",
          "Classify each result independently with the closest allowed result_type.",
          "Write summary.narrative as one concise sentence of 25 to 45 words that compresses the supported situation, action, and result.",
          "Do not return HTML, Markdown, evidence IDs inside prose, source metadata, or a case-study asset."
        ].join(" "),
        input: JSON.stringify({
          selectedTopics: topics,
          project_id: item.project_id,
          project_name: item.project_name,
          relevance: item.relevance,
          evidence: projectEvidence
        }),
        text: {
          format: {
            type: "json_schema",
            name: `proof_item_${item.project_id.replaceAll("-", "_")}`,
            strict: true,
            schema: generatedProofItemJsonSchema(item)
          }
        }
      });
    }) : [];

    const [response, ...proofValues] = await Promise.all([framingRequest, ...proofRequests]);
    let framingStatus: GenerationStatus = "ai";
    let validationStatus: ValidationStatus | undefined;
    let diagnostics = fallbackDiagnostics;
    let framedNarrative: Narrative | null = null;
    let upstreamStatus: number | undefined;
    if (!response.ok) {
      framingStatus = "upstream-error";
      upstreamStatus = response.status;
      console.warn(`[generation:${requestId}] upstream-error status=${response.status}`);
    } else {
      const result = await response.json() as {
        output_text?: string;
        output?: Array<{ content?: Array<{ text?: string }> }>;
        status?: string;
        error?: { code?: string } | null;
        incomplete_details?: { reason?: string } | null;
      };
      const text = result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim();
      if (!text) {
        framingStatus = "empty-output";
        console.warn(`[generation:${requestId}] empty-output response_status=${result.status || "unknown"} error=${result.error?.code || "none"} incomplete=${result.incomplete_details?.reason || "none"}`);
      } else {
        try {
          framedNarrative = applyAiFraming(JSON.parse(text), fallback, allowedIds, evidenceTextBySection,
            (status) => { validationStatus = status; },
            (value) => { diagnostics = value; });
        } catch {
          framedNarrative = null;
        }
        if (!framedNarrative) {
          framingStatus = "invalid-output";
          console.warn(`[generation:${requestId}] invalid-output validation=${validationStatus || "unknown"}`);
        }
      }
    }
    const baseNarrative = framedNarrative || fallback;
    let generatedProofCount = 0;
    const proofItems = fallbackProofItems.map((item, index) => {
      const evidenceText = evidence.filter((record) => proofItemEvidenceIds(item).includes(record.id)).map((record) => record.claim).join(" ");
      const generated = proofValues[index] ? applyAiProofItem(proofValues[index], item, evidenceText) : null;
      if (generated) generatedProofCount += 1;
      return generated || item;
    });
    const narrative: Narrative = {
      ...baseNarrative,
      mode: framedNarrative || generatedProofCount ? "ai" : "deterministic",
      sections: baseNarrative.sections.map((section) => section.id === "proof-to-scale" && proofItems.length
        ? { ...section, proof_items: proofItems }
        : section)
    };
    if (!validateNarrativeEvidence(narrative, allowedIds) || !validateNarrativeProofProjects(narrative)) {
      return { narrative: fallback, status: "invalid-output", diagnostics: fallbackDiagnostics, validationStatus: "narrative-evidence" };
    }
    const status = framedNarrative || generatedProofCount ? "ai" : framingStatus;
    return { narrative, status, diagnostics, upstreamStatus, validationStatus };
  } catch (error) {
    const status = error instanceof Error && error.name === "AbortError" ? "timeout" : "network-error";
    console.warn(`[generation:${requestId}] ${status}`);
    return { narrative: fallback, status, diagnostics: fallbackDiagnostics };
  }
  finally { clearTimeout(timeout); }
}

export async function generateNarrative(topics: TopicId[], fetcher: typeof fetch = fetch): Promise<Narrative> {
  return (await generateNarrativeWithStatus(topics, fetcher)).narrative;
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomUUID();
  const origin = event.headers.origin || "";
  const corsOrigin = allowedOrigin(origin, event.headers.host || "");
  if (event.httpMethod === "OPTIONS") return { statusCode: corsOrigin ? 204 : 403, headers: { ...headersFor(corsOrigin), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } };
  if (origin && !corsOrigin) return { statusCode: 403, body: JSON.stringify({ error: "Origin not allowed", requestId }) };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: headersFor(corsOrigin), body: JSON.stringify({ error: "Use POST", requestId }) };
  let body: unknown;
  try { body = JSON.parse(event.body || "{}"); } catch { body = null; }
  const parsed = GenerateRequestSchema.safeParse(body);
  if (!parsed.success) return { statusCode: 400, headers: headersFor(corsOrigin), body: JSON.stringify({ error: "Invalid request", requestId }) };
  const generation = await generateNarrativeWithStatus(parsed.data.topics, fetch, requestId);
  const narrative = generation.narrative;
  const relevantIds = new Set(narrative.sections.flatMap((section) => section.evidenceRefs));
  const evidence = narrative.grounding === "candidate_validation"
    ? publicCandidateEvidence(relevantIds)
    : contentPacket.evidence.filter((record) => relevantIds.has(record.id)).map(publicEvidenceView);
  return {
    statusCode: 200,
    headers: {
      ...headersFor(corsOrigin),
      "X-Portfolio-Generation-Status": generation.status,
      ...(generation.upstreamStatus ? { "X-Portfolio-Upstream-Status": String(generation.upstreamStatus) } : {}),
      ...(generation.validationStatus ? { "X-Portfolio-Validation-Status": generation.validationStatus } : {})
    },
    body: JSON.stringify({ narrative: { ...narrative, requestId }, evidence, generation: generation.diagnostics, requestId })
  };
};

