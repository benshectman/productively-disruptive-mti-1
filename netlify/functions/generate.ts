import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";
import { contentPacket, publicEvidenceView, sourceById } from "../../src/content/content";
import { assembleNarrative, validateNarrativeEvidence } from "../../src/shared/narrative";
import { z } from "zod";
import { GenerateRequestSchema, type Narrative, type TopicId } from "../../src/shared/contracts";
import { assembleCandidateNarrative, candidateValidationEnabled, candidateValidationIds, publicCandidateEvidence } from "./candidate-validation";
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

const FramingSectionSchema = z.object({
  id: z.enum(["system-behind-design", "operating-model", "proof-to-scale", "institutionalized-capability"]),
  headline: GeneratedHeadlineSchema,
  summary: generatedProseSchema(40, 900).refine((value) => value.trim().split(/\s+/).length <= 75, "Generated leads must stay concise"),
  detail: generatedProseSchema(80, 1600)
}).strict();
const FramingSchema = z.object({ sections: z.array(FramingSectionSchema).length(4) }).strict();

function numericTokens(text: string): string[] {
  return text.match(/(?<![A-Za-z])\$?\d[\d,]*(?:\.\d+)?(?:%|\s*percent(?:age points?)?|\s*(?:-| )?points?)?/gi) || [];
}

function normalizedNumericToken(token: string): string {
  return token.toLowerCase().replaceAll(",", "").replace(/[\s-]+/g, "")
    .replace(/percentagepoints?$/, "point").replace(/points?$/, "point").replace(/percent$/, "%");
}

function generatedProseIsGrounded(generated: { summary: string; detail: string }, evidenceText: string): boolean {
  const evidenceNumbers = new Set(numericTokens(evidenceText).map(normalizedNumericToken));
  const numbersAreGrounded = numericTokens(`${generated.summary} ${generated.detail}`)
    .every((token) => evidenceNumbers.has(normalizedNumericToken(token)));
  if (!numbersAreGrounded) return false;

  // Aggregating unlike measures into one threshold claim caused the known SPR
  // distortion (114%, 85%, 122%, and 104 NPS points became "all over 100%").
  // Require quantitative comparisons to remain attached to individual measures.
  const unsupportedAggregate = /\b(all|each|every|both)\b[^.!?]{0,120}\b(over|above|exceed(?:ed|ing)?|more than|greater than|at least)\b[^.!?]{0,30}\d/i;
  return !unsupportedAggregate.test(`${generated.summary} ${generated.detail}`);
}

export function applyAiFraming(
  value: unknown,
  fallback: Narrative,
  allowedIds?: Set<string>,
  evidenceTextBySection?: Map<string, string>,
  onReject?: (status: ValidationStatus) => void,
): Narrative | null {
  const result = FramingSchema.safeParse(value);
  if (!result.success) { onReject?.("schema"); return null; }
  const framingById = new Map(result.data.sections.map((section) => [section.id, section]));
  if (framingById.size !== fallback.sections.length || fallback.sections.some((section) => !framingById.has(section.id as typeof result.data.sections[number]["id"]))) {
    onReject?.("section-ids"); return null;
  }
  if (evidenceTextBySection && fallback.sections.some((section) => !generatedProseIsGrounded(
    framingById.get(section.id as typeof result.data.sections[number]["id"])!, evidenceTextBySection.get(section.id) || ""
  ))) { onReject?.("numeric-grounding"); return null; }
  const narrative: Narrative = {
    mode: "ai",
    grounding: fallback.grounding,
    sections: fallback.sections.map((section) => {
      const framing = framingById.get(section.id as typeof result.data.sections[number]["id"])!;
      const headline = headlineAcronymsAreExplained(framing.headline, framing.summary)
        ? framing.headline
        : section.headline;
      return { ...section, headline, summary: framing.summary, detail: framing.detail };
    })
  };
  if (!validateNarrativeEvidence(narrative, allowedIds)) { onReject?.("narrative-evidence"); return null; }
  return narrative;
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
Promise<{ narrative: Narrative; status: GenerationStatus; upstreamStatus?: number; validationStatus?: ValidationStatus }> {
  const useCandidates = candidateValidationEnabled();
  const fallback = useCandidates ? assembleCandidateNarrative(topics) : assembleNarrative(topics);
  const allowedIds = useCandidates ? candidateValidationIds : undefined;
  if (!process.env.OPENAI_API_KEY) return { narrative: fallback, status: "missing-api-key" };
  const evidence = constrainedEvidence(fallback);
  const evidenceTextBySection = new Map(fallback.sections.map((section) => [
    section.id,
    evidence.filter((item) => section.evidenceRefs.includes(item.id)).map((item) => item.claim).join(" ")
  ]));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  try {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini", store: false, max_output_tokens: 2800,
        instructions: [
          "Write the headline, concise lead, and fuller detail for four sections of one continuous professional portfolio narrative.",
          "Return every supplied section ID exactly once. Do not change the section structure or add sections.",
          "Follow the supplied narrative arc in order: establish Ben's career-wide identity, move into recent leadership, show topic-relevant proof in practice, then connect it to the longer career throughline.",
          "Make the sequence of headlines build from broad identity to recent leadership, proof, and career throughline. Do not repeat the same claim or construction.",
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
            evidence: evidence.filter((item) => section.evidenceRefs.includes(item.id))
          }))
        }),
        text: { format: { type: "json_schema", name: "portfolio_narrative", strict: true, schema: generatedNarrativeJsonSchema } }
      })
    });
    if (!response.ok) {
      console.warn(`[generation:${requestId}] upstream-error status=${response.status}`);
      return { narrative: fallback, status: "upstream-error", upstreamStatus: response.status };
    }
    const result = await response.json() as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      status?: string;
      error?: { code?: string } | null;
      incomplete_details?: { reason?: string } | null;
    };
    const text = result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim();
    if (!text) {
      console.warn(`[generation:${requestId}] empty-output response_status=${result.status || "unknown"} error=${result.error?.code || "none"} incomplete=${result.incomplete_details?.reason || "none"}`);
      return { narrative: fallback, status: "empty-output" };
    }
    let validationStatus: ValidationStatus | undefined;
    const framed = applyAiFraming(JSON.parse(text), fallback, allowedIds, evidenceTextBySection, (status) => { validationStatus = status; });
    if (!framed) {
      console.warn(`[generation:${requestId}] invalid-output validation=${validationStatus || "unknown"}`);
      return { narrative: fallback, status: "invalid-output", validationStatus };
    }
    return { narrative: framed, status: "ai" };
  } catch (error) {
    const status = error instanceof Error && error.name === "AbortError" ? "timeout" : "network-error";
    console.warn(`[generation:${requestId}] ${status}`);
    return { narrative: fallback, status };
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
    body: JSON.stringify({ narrative: { ...narrative, requestId }, evidence, requestId })
  };
};

