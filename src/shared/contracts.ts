import { z } from "zod";

export const GenerateRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000)
});

export const GenerateResponseSchema = z.object({
  answer: z.string().optional(),
  error: z.string().optional(),
  requestId: z.string().optional()
}).refine((value) => Boolean(value.answer) !== Boolean(value.error), {
  message: "Response must contain either answer or error"
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;
export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;
