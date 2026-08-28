import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";
import { contentPacket, publicEvidenceView, sourceById } from "../../src/content/content";
import { assembleNarrative, validateNarrativeEvidence } from "../../src/shared/narrative";
import { z } from "zod";
import { GenerateRequestSchema, type Narrative, type TopicId } from "../../src/shared/contracts";
import { assembleCandidateNarrative, candidateValidationEnabled, candidateValidationIds, publicCandidateEvidence } from "./candidate-validation";

const headersFor = (origin: string) => ({ "Content-Type": "application/json", ...(origin ? { "Access-Control-Allow-Origin": origin } : {}), "Vary": "Origin" });
function allowedOrigin(origin = "") {
  const allowlist = (process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return allowlist.includes(origin) ? origin : "";
}

const framingJsonSchema = {
  type: "object", additionalProperties: false, required: ["sections"],
  properties: {
    sections: {
      type: "array", minItems: 4, maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "headline", "summary"],
        properties: {
          id: { type: "string", enum: ["system-behind-design", "operating-model", "proof-to-scale", "institutionalized-capability"] },
          headline: { type: "string", minLength: 1, maxLength: 140 },
          summary: { type: "string", minLength: 1, maxLength: 900 }
        }
      }
    }
  }
};

const FramingSectionSchema = z.object({
  id: z.enum(["system-behind-design", "operating-model", "proof-to-scale", "institutionalized-capability"]),
  headline: z.string().min(1).max(140),
  summary: z.string().min(1).max(900)
}).strict();
const FramingSchema = z.object({ sections: z.array(FramingSectionSchema).length(4) }).strict();

export function applyAiFraming(value: unknown, fallback: Narrative, allowedIds?: Set<string>): Narrative | null {
  const result = FramingSchema.safeParse(value);
  if (!result.success) return null;
  const framingById = new Map(result.data.sections.map((section) => [section.id, section]));
  if (framingById.size !== fallback.sections.length || fallback.sections.some((section) => !framingById.has(section.id as typeof result.data.sections[number]["id"]))) return null;
  const narrative: Narrative = {
    mode: "ai",
    grounding: fallback.grounding,
    sections: fallback.sections.map((section) => {
      const framing = framingById.get(section.id as typeof result.data.sections[number]["id"])!;
      return { ...section, headline: framing.headline, summary: framing.summary };
    })
  };
  return validateNarrativeEvidence(narrative, allowedIds) ? narrative : null;
}

function constrainedEvidence(fallback: Narrative) {
  const relevantIds = new Set(fallback.sections.flatMap((section) => section.evidenceRefs));
  if (fallback.grounding === "candidate_validation") return publicCandidateEvidence(relevantIds);
  return contentPacket.evidence.filter((record) => relevantIds.has(record.id)).map((record) => ({
    ...publicEvidenceView(record),
    sourceAuthority: [...new Set(record.sources.map((id) => sourceById.get(id)?.authority).filter(Boolean))]
  }));
}

export async function generateNarrative(topics: TopicId[], fetcher: typeof fetch = fetch): Promise<Narrative> {
  const useCandidates = candidateValidationEnabled();
  const fallback = useCandidates ? assembleCandidateNarrative(topics) : assembleNarrative(topics);
  const allowedIds = useCandidates ? candidateValidationIds : undefined;
  if (!process.env.OPENAI_API_KEY) return fallback;
  const evidence = constrainedEvidence(fallback);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8500);
  try {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini", store: false, max_output_tokens: 1400,
        instructions: [
          "Rewrite only the headline and summary framing for the four supplied portfolio sections.",
          "Return every supplied section ID exactly once. Do not change the section structure or add sections.",
          useCandidates
            ? "This is an explicitly labeled validation run using unapproved candidate BenFacts. Use only the candidate facts assigned to each section; do not imply that they have been approved."
            : "Use only the approved proposition and evidence assigned to each section.",
          "Preserve every record's attribution. Never turn shared or organizational work into Ben's personal execution.",
          "Do not invent accomplishments, metrics, dates, product descriptions, acronym expansions, or propositions.",
          "Claims supported only by first_person_attestation must not be described as independently documented.",
          "Use plain external language. Experience Design Management Office (XDMO) is the approved expansion on first use.",
          "Do not return HTML, Markdown, evidence IDs, attribution fields, disclosure choices, or design-system markup."
        ].join(" "),
        input: JSON.stringify({
          selectedTopics: topics,
          groundingMode: fallback.grounding,
          approvedProposition: useCandidates ? undefined : contentPacket.propositions[0].statement,
          sections: fallback.sections.map((section) => ({
            id: section.id,
            purpose: section.purpose,
            evidence: evidence.filter((item) => section.evidenceRefs.includes(item.id))
          }))
        }),
        text: { format: { type: "json_schema", name: "portfolio_framing", strict: true, schema: framingJsonSchema } }
      })
    });
    if (!response.ok) return fallback;
    const result = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim();
    if (!text) return fallback;
    return applyAiFraming(JSON.parse(text), fallback, allowedIds) || fallback;
  } catch { return fallback; }
  finally { clearTimeout(timeout); }
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomUUID();
  const origin = event.headers.origin || "";
  const corsOrigin = allowedOrigin(origin);
  if (event.httpMethod === "OPTIONS") return { statusCode: corsOrigin ? 204 : 403, headers: { ...headersFor(corsOrigin), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } };
  if (origin && !corsOrigin) return { statusCode: 403, body: JSON.stringify({ error: "Origin not allowed", requestId }) };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: headersFor(corsOrigin), body: JSON.stringify({ error: "Use POST", requestId }) };
  let body: unknown;
  try { body = JSON.parse(event.body || "{}"); } catch { body = null; }
  const parsed = GenerateRequestSchema.safeParse(body);
  if (!parsed.success) return { statusCode: 400, headers: headersFor(corsOrigin), body: JSON.stringify({ error: "Invalid request", requestId }) };
  const narrative = await generateNarrative(parsed.data.topics);
  const relevantIds = new Set(narrative.sections.flatMap((section) => section.evidenceRefs));
  const evidence = narrative.grounding === "candidate_validation"
    ? publicCandidateEvidence(relevantIds)
    : contentPacket.evidence.filter((record) => relevantIds.has(record.id)).map(publicEvidenceView);
  return { statusCode: 200, headers: headersFor(corsOrigin), body: JSON.stringify({ narrative: { ...narrative, requestId }, evidence, requestId }) };
};

