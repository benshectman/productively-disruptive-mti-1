import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanPath = path.join(root, "src/content/candidates/ben-facts-clean-preapproval-queue.v0.2.json");
const baselinePath = path.join(root, "src/content/candidates/ben-facts-migration.v0.3.json");
const outputPath = path.join(root, "src/content/review/ben-facts-review.v1.json");
const clean = JSON.parse(fs.readFileSync(cleanPath, "utf8"));
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const byId = new Map(baseline.candidates.map((candidate) => [candidate.candidate_id, candidate]));

const uniqueSourceRefs = (records) => {
  const refs = new Map();
  for (const record of records) for (const source of record?.source_refs ?? []) {
    const existing = refs.get(source.source_id);
    if (!existing) refs.set(source.source_id, structuredClone(source));
    else {
      const locations = [...(existing.locations ?? []), ...(source.locations ?? [])];
      existing.locations = [...new Map(locations.map((location) => [JSON.stringify(location), location])).values()];
    }
  }
  return [...refs.values()];
};

const inheritedRecords = (item) => (item.source_inheritance ?? [item.candidate_id]).map((id) => byId.get(id)).filter(Boolean);
const strongestEvidence = (records) => records.map((record) => record?.evidence_strength).filter(Boolean).sort().at(-1);
const normalizeVisibility = (value) => value === "knowledge_only" ? "knowledge_only" : "shareable";

const baselineCandidates = clean.baseline_queue.map((item) => {
  const direct = byId.get(item.candidate_id);
  const inherited = inheritedRecords(item);
  const source = direct ?? inherited[0] ?? {};
  return {
    candidate_id: item.candidate_id,
    original_text: item.original_text ?? source.original_text,
    reviewed_text: item.original_text ?? source.original_text,
    attribution: item.resolved_attribution ?? item.attribution ?? source.attribution,
    topics: item.proposed_topics ?? source.proposed_topics ?? [],
    ...(item.project_id ?? source.project_id ? { project_id: item.project_id ?? source.project_id } : {}),
    visibility: normalizeVisibility(item.visibility ?? source.visibility),
    source_refs: uniqueSourceRefs(inherited.length ? inherited : [source]),
    ...(strongestEvidence(inherited.length ? inherited : [source]) ? { evidence_strength: strongestEvidence(inherited.length ? inherited : [source]) } : {}),
    ...(source.evidence_strength_rationale ? { evidence_strength_rationale: source.evidence_strength_rationale } : {}),
    review_status: "unreviewed",
    ...(item.review_note || source.review?.notes ? { review_notes: [item.review_note, source.review?.notes].filter(Boolean).join(" ") } : {}),
    origin: "baseline",
    ...(source.target_type ? { target_type: source.target_type } : {}),
    mechanical_status: item.mechanical_status,
    ...(source.review ? { mechanical_review: source.review } : {}),
    ...(item.replaces_candidate_id || item.source_inheritance || item.reason ? { lineage: {
      ...(item.replaces_candidate_id ? { replaces_candidate_id: item.replaces_candidate_id } : {}),
      ...(item.source_inheritance ? { source_inheritance: item.source_inheritance } : {}),
      ...(item.reason ? { reason: item.reason } : {})
    } } : {}),
    ...(source.legacy ? { legacy: source.legacy } : {})
  };
});

const expansionCandidates = clean.expansion_queue.map((item) => ({
  candidate_id: item.candidate_id,
  original_text: item.original_text,
  reviewed_text: item.original_text,
  attribution: item.attribution,
  topics: item.proposed_topics ?? [],
  ...(item.project_id ? { project_id: item.project_id } : {}),
  visibility: normalizeVisibility(item.visibility),
  source_refs: item.source_refs ?? [],
  ...(item.evidence_strength ? { evidence_strength: item.evidence_strength } : {}),
  review_status: "unreviewed",
  ...(item.review?.notes ? { review_notes: item.review.notes } : {}),
  origin: "expansion",
  ...(item.target_type ? { target_type: item.target_type } : {}),
  mechanical_status: item.mechanical_status,
  ...(item.review ? { mechanical_review: item.review } : {}),
  ...(item.overlap_review ? { overlap_review: item.overlap_review } : {})
}));

const candidates = [...baselineCandidates, ...expansionCandidates];
if (candidates.length !== 147 || new Set(candidates.map((item) => item.candidate_id)).size !== 147) throw new Error("Expected 147 unique candidates");
if (candidates.some((item) => !item.original_text || item.attribution === "undetermined")) throw new Error("Normalization left required review fields unresolved");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({
  meta: {
    name: "BenFacts review corpus",
    version: "1.0",
    source: "ben-facts-clean-preapproval-queue.v0.2.json",
    candidate_count: 147,
    status: "human_review_required",
    important: "No fact in this file begins approved. Approval requires an explicit human review decision."
  },
  candidates
}, null, 2)}\n`);

