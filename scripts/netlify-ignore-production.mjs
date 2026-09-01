import { execFileSync } from "node:child_process";
import { isReleaseCommit } from "./netlify-release-policy.mjs";
const commitRef = process.env.COMMIT_REF?.trim();

if (!commitRef) {
  console.log("Skipping production build: COMMIT_REF is unavailable.");
  process.exit(0);
}

let commitMessage;

try {
  commitMessage = execFileSync(
    "git",
    ["show", "-s", "--format=%B", commitRef],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch {
  console.log("Skipping production build: commit message could not be read.");
  process.exit(0);
}

if (isReleaseCommit(commitMessage)) {
  console.log("Release marker found; continuing with the production build.");
  process.exit(1);
}

console.log("Skipping production build: commit message does not contain [release].");
process.exit(0);
