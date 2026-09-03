import { z } from "zod";
import { TopicIdSchema } from "./contracts";

export const AttributionSchema = z.enum(["personal", "leadership", "team", "shared_leadership", "organization"]);
export const ReviewStatusSchema = z.enum(["unreviewed", "approved", "hold", "rejected"]);
export const ReviewVisibilitySchema = z.enum(["shareable", "knowledge_only"]);

export const SourceLocationSchema = z.object({
  kind: z.string().min(1),
  number: z.number().int().positive().optional(),
  label: z.string().min(1).optional()
}).passthrough();

export const SourceRefSchema = z.object({
  source_id: z.string().min(1),
  locations: z.array(SourceLocationSchema).default([])
}).passthrough();

export const BenFactReviewSchema = z.object({
  candidate_id: z.string().regex(/^BF-[CX]-\d{3}[A-Z]?$/),
  original_text: z.string().min(1),
  reviewed_text: z.string().min(1),
  attribution: AttributionSchema,
  topics: z.array(TopicIdSchema).max(4),
  project_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  visibility: ReviewVisibilitySchema,
  source_refs: z.array(SourceRefSchema),
  evidence_strength: z.string().optional(),
  evidence_strength_rationale: z.string().optional(),
  review_status: ReviewStatusSchema,
  review_notes: z.string().optional(),
  origin: z.enum(["baseline", "expansion"]),
  reviewed_at: z.string().datetime().optional(),
  target_type: z.string().optional(),
  mechanical_status: z.string().optional(),
  mechanical_review: z.unknown().optional(),
  overlap_review: z.unknown().optional(),
  lineage: z.unknown().optional(),
  legacy: z.unknown().optional()
}).strict();

export const BenFactsReviewCorpusSchema = z.object({
  meta: z.object({
    name: z.string(),
    version: z.literal("1.0"),
    source: z.string(),
    candidate_count: z.literal(147),
    status: z.literal("human_review_required"),
    important: z.string()
  }).passthrough(),
  candidates: z.array(BenFactReviewSchema).length(147).superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.candidate_id)) ctx.addIssue({ code: "custom", path: [index, "candidate_id"], message: "Candidate ID must be unique" });
      seen.add(item.candidate_id);
    });
  })
}).strict();

export type BenFactReview = z.infer<typeof BenFactReviewSchema>;
export type BenFactsReviewCorpus = z.infer<typeof BenFactsReviewCorpusSchema>;
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

