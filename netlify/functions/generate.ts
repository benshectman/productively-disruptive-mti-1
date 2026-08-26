import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";
import { contentPacket, publicEvidenceView, sourceById } from "../../src/content/content";
import { assembleNarrative, selectEvidence, validateNarrativeEvidence } from "../../src/shared/narrative";
import { GenerateRequestSchema, NarrativeSchema, type Narrative, type TopicId } from "../../src/shared/contracts";

const headersFor = (origin: string) => ({ "Content-Type": "application/json", ...(origin ? { "Access-Control-Allow-Origin": origin } : {}), "Vary": "Origin" });
function allowedOrigin(origin = "") {
  const allowlist = (process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return allowlist.includes(origin) ? origin : "";
}

const narrativeJsonSchema = {
  type: "object", additionalProperties: false, required: ["sections"],
  properties: {
    sections: {
      type: "array", minItems: 3, maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "purpose", "headline", "summary", "evidenceRefs", "disclosure"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          purpose: { type: "string", enum: ["proposition", "evidence", "transition", "story"] },
          headline: { type: "string", minLength: 1, maxLength: 140 },
          summary: { type: "string", minLength: 1, maxLength: 900 },
          evidenceRefs: { type: "array", minItems: 1, maxItems: 9, items: { type: "string", pattern: "^E-\\d{3}$" } },
          disclosure: { type: "string", enum: ["none", "inline", "deep-dive"] }
        }
      }
    }
  }
};

export function validateAiNarrative(value: unknown, allowedEvidenceIds: Set<string>): Narrative | null {
  const result = NarrativeSchema.safeParse({ ...(typeof value === "object" && value ? value : {}), mode: "ai" });
  return result.success && validateNarrativeEvidence(result.data, allowedEvidenceIds) ? result.data : null;
}

function constrainedEvidence(topics: TopicId[]) {
  return selectEvidence(topics).map((record) => ({
    ...publicEvidenceView(record),
    sourceAuthority: [...new Set(record.sources.map((id) => sourceById.get(id)?.authority).filter(Boolean))]
  }));
}

export async function generateNarrative(topics: TopicId[], fetcher: typeof fetch = fetch): Promise<Narrative> {
  const fallback = assembleNarrative(topics);
  if (!process.env.OPENAI_API_KEY) return fallback;
  const evidence = constrainedEvidence(topics);
  const allowedIds = new Set(evidence.map((item) => item.id));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8500);
  try {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini", store: false, max_output_tokens: 1400,
        instructions: [
          "Frame a concise professional portfolio using only the approved proposition and evidence supplied.",
          "Preserve every record's attribution. Never turn shared or organizational work into Ben's personal execution.",
          "Do not invent accomplishments, metrics, dates, product descriptions, acronym expansions, or propositions.",
          "Claims supported only by first_person_attestation must not be described as independently documented.",
          "Return 3 or 4 intentionally sequenced semantic sections. Every section must cite only supplied evidence IDs.",
          "Use plain external language. Experience Design Management Office (XDMO) is the approved expansion on first use."
        ].join(" "),
        input: JSON.stringify({ selectedTopics: topics, approvedProposition: contentPacket.propositions[0], approvedEvidence: evidence }),
        text: { format: { type: "json_schema", name: "portfolio_narrative", strict: true, schema: narrativeJsonSchema } }
      })
    });
    if (!response.ok) return fallback;
    const result = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = result.output_text || result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("").trim();
    if (!text) return fallback;
    return validateAiNarrative(JSON.parse(text), allowedIds) || fallback;
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
  return { statusCode: 200, headers: headersFor(corsOrigin), body: JSON.stringify({ narrative: { ...narrative, requestId }, requestId }) };
};

