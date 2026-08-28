import { z } from "zod";

export const TopicIdSchema = z.enum(["T-001", "T-002", "T-003", "T-004"]);
export const DesignSystemSchema = z.literal("astryx");
export const ThemeSchema = z.literal("neutral");
export const GroundingModeSchema = z.enum(["approved", "candidate_validation"]);

export const PublicEvidenceSchema = z.object({
  id: z.string().regex(/^(E-\d{3}|BF-C-\d{3})$/),
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
  headline: z.string().min(1).max(140),
  summary: z.string().min(1).max(900),
  evidenceRefs: z.array(z.string().regex(/^(E-\d{3}|BF-C-\d{3})$/)).min(1).max(9),
  disclosure: z.enum(["none", "inline", "deep-dive"]),
  detail: z.string().min(1).max(1600).optional()
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
export type PublicEvidence = z.infer<typeof PublicEvidenceSchema>;
export type Attribution = PublicEvidence["attribution"];
export type GroundingMode = z.infer<typeof GroundingModeSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

export type VisitorContext = VisitorConfiguration & {
  inlineExpansionsOpened: string[];
  deepDivesOpened: string[];
};

