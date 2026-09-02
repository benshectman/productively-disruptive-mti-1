import { z } from "zod";

export const TopicIdSchema = z.enum(["T-001", "T-002", "T-003", "T-004"]);
export const DesignSystemSchema = z.literal("astryx");
export const ThemeSchema = z.literal("neutral");
export const GroundingModeSchema = z.enum(["approved", "candidate_validation"]);
const EvidenceFactIdSchema = z.string().regex(/^(E-\d{3}|BF-C-\d{3})$/);

export const ProofNarrativeSchema = z.object({
  narrative: z.string().min(1).max(1200),
  evidence_fact_ids: z.array(EvidenceFactIdSchema).min(1).max(9)
}).strict();

export const ProofActionSchema = z.object({
  action: z.string().min(1).max(1200),
  evidence_fact_ids: z.array(EvidenceFactIdSchema).min(1).max(9)
}).strict();

export const ProofResultTypeSchema = z.enum([
  "business_decision",
  "financial_impact",
  "experience_measurement",
  "delivery_output",
  "research_output",
  "adoption_or_reach",
  "other_documented_outcome"
]);

export const ProofResultSchema = z.object({
  result: z.string().min(1).max(1200),
  result_type: ProofResultTypeSchema,
  evidence_fact_ids: z.array(EvidenceFactIdSchema).min(1).max(9)
}).strict();

export const ProofItemSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  project_name: z.string().min(1).max(120),
  relevance: z.string().min(1).max(240),
  situation: ProofNarrativeSchema,
  task: ProofNarrativeSchema,
  actions: z.array(ProofActionSchema).min(1).max(6),
  results: z.array(ProofResultSchema).min(1).max(6),
  summary: ProofNarrativeSchema.extend({
    narrative: z.string().min(1).max(600)
      .refine((value) => !/[.!?]\s+\S/.test(value), "Proof summaries must be one sentence")
      .refine((value) => {
        const words = value.trim().split(/\s+/).filter(Boolean).length;
        return words >= 25 && words <= 45;
      }, "Proof summaries must contain 25 to 45 words")
  }).strict(),
  case_study_asset_id: z.string().min(1).max(100).optional()
}).strict();

export const PublicEvidenceSchema = z.object({
  id: EvidenceFactIdSchema,
  claim: z.string().min(1).max(1200),
  attribution: z.enum(["personal", "leadership", "team", "organization", "shared_leadership"]),
  topics: z.array(TopicIdSchema).max(4)
});

export const VisitorConfigurationSchema = z.object({
  designSystem: DesignSystemSchema,
  theme: ThemeSchema,
  topics: z.array(TopicIdSchema).max(4).refine((items) => new Set(items).size === items.length)
});

export const NarrativeSectionSchema = z.object({
  id: z.string().min(1).max(80),
  purpose: z.enum(["proposition", "evidence", "transition", "story"]),
  eyebrow: z.string().min(1).max(60),
  headline: z.string().min(1).max(140),
  summary: z.string().min(1).max(900),
  evidenceRefs: z.array(EvidenceFactIdSchema).min(1).max(12),
  disclosure: z.enum(["none", "inline", "deep-dive"]),
  detail: z.string().min(1).max(1600).optional(),
  proof_items: z.array(ProofItemSchema).min(1).max(3).optional()
});

export const NarrativeSchema = z.object({
  sections: z.array(NarrativeSectionSchema).min(3).max(4),
  mode: z.enum(["deterministic", "ai"]),
  grounding: GroundingModeSchema.default("approved"),
  requestId: z.string().optional()
});

export const GenerateRequestSchema = VisitorConfigurationSchema;
export const GenerateResponseSchema = z.object({
  narrative: NarrativeSchema,
  evidence: z.array(PublicEvidenceSchema).max(36).optional(),
  requestId: z.string()
});

export type TopicId = z.infer<typeof TopicIdSchema>;
export type VisitorConfiguration = z.infer<typeof VisitorConfigurationSchema>;
export type NarrativeSection = z.infer<typeof NarrativeSectionSchema>;
export type Narrative = z.infer<typeof NarrativeSchema>;
export type ProofItem = z.infer<typeof ProofItemSchema>;
export type ProofResultType = z.infer<typeof ProofResultTypeSchema>;
export type PublicEvidence = z.infer<typeof PublicEvidenceSchema>;
export type Attribution = PublicEvidence["attribution"];
export type GroundingMode = z.infer<typeof GroundingModeSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

export type VisitorContext = VisitorConfiguration & {
  inlineExpansionsOpened: string[];
  deepDivesOpened: string[];
};

