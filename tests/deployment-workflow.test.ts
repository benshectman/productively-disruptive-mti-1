import { describe, expect, it } from "vitest";

import { isReleaseCommit } from "../scripts/netlify-release-policy.mjs";

describe("Netlify production release policy", () => {
  it("allows an explicitly marked release commit", () => {
    expect(isReleaseCommit("[release] Publish validated develop branch")).toBe(true);
  });

  it("matches the release marker case-insensitively", () => {
    expect(isReleaseCommit("Merge pull request\n\n[Release] September update")).toBe(true);
  });

  it("skips routine and ambiguous commits", () => {
    expect(isReleaseCommit("Merge develop into main")).toBe(false);
    expect(isReleaseCommit("Document the release process")).toBe(false);
    expect(isReleaseCommit("release candidate")).toBe(false);
  });
});
