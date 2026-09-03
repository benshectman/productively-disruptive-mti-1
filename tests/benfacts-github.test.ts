import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reviewJson from "../src/content/review/ben-facts-review.v1.json";
import { handler } from "../netlify/functions/benfacts-review";

const originalEnv = { ...process.env };
const event = (httpMethod: string, body?: unknown) => ({ httpMethod, body: body ? JSON.stringify(body) : null }) as never;

describe("BenFacts GitHub persistence", () => {
  beforeEach(() => {
    process.env.CONTEXT = "deploy-preview";
    process.env.GITHUB_TOKEN = "server-only-test-token";
    process.env.GITHUB_REPO = "benshectman/productively-disruptive-mti-1";
    process.env.BENFACTS_REVIEW_BRANCH = "feature/benfacts-editor";
  });
  afterEach(() => { process.env = { ...originalEnv }; vi.unstubAllGlobals(); });

  it("loads a corpus with its GitHub SHA", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(reviewJson)).toString("base64"), sha: "sha-1" }), { status: 200 })));
    const response = (await handler(event("GET"), {} as never))!;
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!).sha).toBe("sha-1");
  });

  it("sends the expected SHA and accepts the new SHA", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: { sha: "sha-2" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = (await handler(event("PUT", { corpus: reviewJson, expectedSha: "sha-1", candidateId: reviewJson.candidates[0].candidate_id }), {} as never))!;
    expect(response.statusCode).toBe(200);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.sha).toBe("sha-1");
    expect(JSON.parse(response.body!).sha).toBe("sha-2");
  });

  it("returns a conflict instead of overwriting a stale SHA", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "sha does not match" }), { status: 409 })));
    const response = (await handler(event("PUT", { corpus: reviewJson, expectedSha: "stale", candidateId: reviewJson.candidates[0].candidate_id }), {} as never))!;
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body!).error).toMatch(/changed since/);
  });
});
