import { z } from 'zod';
import { uuidSchema } from '../common.js';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  types: z.string().max(100).optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const SEARCH_RESULT_TYPES = ['employee', 'device', 'branch', 'department'] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const searchResultItemSchema = z.object({
  type: z.enum(SEARCH_RESULT_TYPES),
  id: uuidSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  status: z.string().nullable(),
});
export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

export const searchResultSchema = z.object({
  q: z.string(),
  employees: z.array(searchResultItemSchema),
  devices: z.array(searchResultItemSchema),
  branches: z.array(searchResultItemSchema),
  departments: z.array(searchResultItemSchema),
});
export type SearchResult = z.infer<typeof searchResultSchema>;
