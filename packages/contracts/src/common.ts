import { z } from 'zod';

/** Any 8-4-4-4-12 hex id: seeded reference rows (system roles, plans) use fixed non-RFC-9562 ids, so strict z.uuid() would reject them. */
export const uuidSchema = z.guid();
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Expected HH:mm');
export const timezoneSchema = z.string().min(1).max(64);
export const countryCodeSchema = z.string().length(2).toUpperCase();
export const currencyCodeSchema = z.string().length(3).toUpperCase();
export const codeSchema = z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Letters, digits, - _ . only');
export const emailSchema = z.email().max(254);
export const phoneSchema = z.string().trim().min(5).max(32).regex(/^[+\d][\d\s()-]*$/, 'Invalid phone number');
export const weeklyOffDaysSchema = z.array(z.number().int().min(0).max(6)).max(7);
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(64).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const cursorQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export interface PageMeta { page: number; pageSize: number; total: number; totalPages: number }
export interface Paginated<T> { data: T[]; meta: PageMeta }
export interface CursorPage<T> { data: T[]; meta: { nextCursor: string | null; limit: number } }
export interface ApiEnvelope<T> { data: T; meta?: Record<string, unknown> }
export interface ApiErrorBody { code: string; message: string; requestId: string; details?: Record<string, unknown> }

export const addressSchema = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: countryCodeSchema.optional(),
}).partial();
export type Address = z.infer<typeof addressSchema>;

export const contactSchema = z.object({
  name: z.string().max(200).optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  website: z.url().optional(),
}).partial();
export type Contact = z.infer<typeof contactSchema>;

/** Accepted job response for asynchronous operations (§104). */
export interface JobAccepted { jobId: string; status: 'QUEUED'; message: string }
