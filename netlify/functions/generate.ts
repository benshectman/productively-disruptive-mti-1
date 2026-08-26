import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";
import evidence from "../../src/content/evidence.v0.1.json";
import { GenerateRequestSchema } from "../../src/shared/contracts";

const headersFor = (origin: string) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": origin,
  "Vary": "Origin"
});

function allowedOrigin(origin = "") {
  const allowlist = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowlist.includes(origin) ? origin : "";
}

export const handler: Handler = async (event) => {
  const requestId = crypto.randomUUID();
  const origin = event.headers.origin || "";
  const corsOrigin = allowedOrigin(origin);

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: corsOrigin ? 204 : 403,
      headers: {
        ...headersFor(corsOrigin),
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      }
    };
  }

  if (origin && !corsOrigin) {
    return { statusCode: 403, body: JSON.stringify({ error: "Origin not allowed", requestId }) };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: headersFor(corsOrigin),
      body: JSON.stringify({ error: "Use POST", requestId })
    };
  }

  let parsed;
  try {
    parsed = GenerateRequestSchema.parse(JSON.parse(event.body || "{}"));
  } catch {
    return {
      statusCode: 400,
      headers: headersFor(corsOrigin),
      body: JSON.stringify({ error: "Invalid request", requestId })
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: headersFor(corsOrigin),
      body: JSON.stringify({ error: "Service is not configured", requestId })
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: "You are the bounded portfolio guide for Productively Disruptive. Use only the supplied approved evidence. Separate fact from interpretation, preserve attribution, acknowledge unknowns, and never invent outcomes."
          },
          { role: "system", content: JSON.stringify(evidence) },
          { role: "user", content: parsed.message }
        ]
      })
    });

    if (!response.ok) {
      console.error("OpenAI request failed", { requestId, status: response.status });
      return {
        statusCode: 502,
        headers: headersFor(corsOrigin),
        body: JSON.stringify({ error: "Generation service failed", requestId })
      };
    }

    const result = await response.json() as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const answer =
      result.output_text ||
      result.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("\n").trim();

    if (!answer) throw new Error("No text returned");

    return {
      statusCode: 200,
      headers: headersFor(corsOrigin),
      body: JSON.stringify({ answer, requestId })
    };
  } catch (error) {
    console.error("Generation error", { requestId, error });
    return {
      statusCode: 500,
      headers: headersFor(corsOrigin),
      body: JSON.stringify({ error: "Generation failed", requestId })
    };
  } finally {
    clearTimeout(timeout);
  }
};
