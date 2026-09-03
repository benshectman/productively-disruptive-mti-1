import type { Handler } from "@netlify/functions";
import { BenFactsReviewCorpusSchema } from "../../src/shared/benfacts-review";

const REVIEW_PATH = "src/content/review/ben-facts-review.v1.json";
const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function configuration() {
  const repository = process.env.GITHUB_REPO || "benshectman/productively-disruptive-mti-1";
  const branch = process.env.BENFACTS_REVIEW_BRANCH || process.env.HEAD || process.env.BRANCH || "feature/benfacts-editor";
  return { repository, branch, token: process.env.GITHUB_TOKEN };
}

async function githubRequest(url: string, init: RequestInit = {}) {
  const { token } = configuration();
  return fetch(url, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
}

export const handler: Handler = async (event) => {
  if (process.env.CONTEXT === "production") return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: "Not available in production" }) };
  const { repository, branch, token } = configuration();
  const url = `https://api.github.com/repos/${repository}/contents/${REVIEW_PATH}`;

  try {
    if (event.httpMethod === "GET") {
      const response = await githubRequest(`${url}?ref=${encodeURIComponent(branch)}`);
      if (!response.ok) return { statusCode: response.status, headers: jsonHeaders, body: JSON.stringify({ error: "Could not load the review corpus from GitHub" }) };
      const payload = await response.json() as { content: string; sha: string };
      const corpus = BenFactsReviewCorpusSchema.parse(JSON.parse(Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8")));
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ corpus, sha: payload.sha, branch }) };
    }

    if (event.httpMethod === "PUT") {
      if (!token) return { statusCode: 503, headers: jsonHeaders, body: JSON.stringify({ error: "GitHub persistence is not configured" }) };
      const body = JSON.parse(event.body || "{}");
      const corpus = BenFactsReviewCorpusSchema.parse(body.corpus);
      if (typeof body.expectedSha !== "string" || !body.expectedSha) return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "The expected GitHub SHA is required" }) };
      const candidate = corpus.candidates.find((item) => item.candidate_id === body.candidateId);
      if (!candidate) return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "The reviewed candidate was not found" }) };
      const edited = candidate.reviewed_text !== candidate.original_text;
      const message = `Review ${candidate.candidate_id}: ${candidate.review_status}${edited && candidate.review_status === "approved" ? " with edits" : ""}`;
      const response = await githubRequest(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          content: Buffer.from(`${JSON.stringify(corpus, null, 2)}\n`).toString("base64"),
          sha: body.expectedSha,
          branch
        })
      });
      if (response.status === 409 || response.status === 422) return { statusCode: 409, headers: jsonHeaders, body: JSON.stringify({ error: "The review corpus changed since this page was loaded. Reload before saving." }) };
      if (!response.ok) return { statusCode: response.status, headers: jsonHeaders, body: JSON.stringify({ error: "Could not save to GitHub" }) };
      const payload = await response.json() as { content?: { sha?: string } };
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ sha: payload.content?.sha, message }) };
    }

    return { statusCode: 405, headers: { ...jsonHeaders, "Allow": "GET, PUT" }, body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected review-corpus error";
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: message }) };
  }
};

export default handler;

