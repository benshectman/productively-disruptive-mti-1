import { afterEach, describe, expect, it } from "vitest";

import { generateNarrativeWithStatus } from "../netlify/functions/generate";

const originalApiKey = process.env.OPENAI_API_KEY;
const originalValidationMode = process.env.BENFACTS_VALIDATION_MODE;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalValidationMode === undefined) delete process.env.BENFACTS_VALIDATION_MODE;
  else process.env.BENFACTS_VALIDATION_MODE = originalValidationMode;
});

describe("generation diagnostics", () => {
  it("identifies a missing API key without exposing a value", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await generateNarrativeWithStatus(["T-001"]);
    expect(result.status).toBe("missing-api-key");
    expect(result.narrative.mode).toBe("deterministic");
  });

  it("records only the status code for an upstream rejection", async () => {
    process.env.OPENAI_API_KEY = "test-secret-that-must-not-be-returned";
    const result = await generateNarrativeWithStatus(
      ["T-001"],
      async () => new Response("sensitive upstream body", { status: 401 }),
      "test-request",
    );
    expect(result.status).toBe("upstream-error");
    expect(result.upstreamStatus).toBe(401);
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(JSON.stringify(result)).not.toContain("sensitive upstream body");
  });
});
