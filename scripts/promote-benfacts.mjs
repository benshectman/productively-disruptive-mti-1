import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "src/content/review/ben-facts-review.v1.json");
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, "src/content/approved/ben-facts.v1.json");
const review = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const facts = review.candidates.filter((candidate) => candidate.review_status === "approved").map((candidate) => ({
  id: candidate.candidate_id,
  claim: candidate.reviewed_text,
  attribution: candidate.attribution,
  topics: candidate.topics,
  ...(candidate.project_id ? { project_id: candidate.project_id } : {}),
  visibility: candidate.visibility,
  source_refs: candidate.source_refs
}));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({ meta: { version: "1.0", generated_from: path.basename(inputPath), approved_count: facts.length }, facts }, null, 2)}\n`);

