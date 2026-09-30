import { z } from 'zod';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';

/**
 * E-mail activity log (migration 20260930000500): every invitation and notification e-mail, where it stands and its timeline.
 *
 * Status: queued → retrying → sent | failed | skipped (the worker), then delivered | delayed | bounced | complained (the
 * provider's webhook). A message `sent` by the `console` provider never left the server (e-mail is not configured).
 */
export const EMAIL_STATUSES = ['queued', 'retrying', 'sent', 'failed', 'skipped', 'delivered', 'delayed', 'bounced', 'complained'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export const EMAIL_KINDS = ['invitation', 'notification'] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];
/** Timeline steps: the pipeline's (queued … skipped) and the provider's (delivered … suppressed). */
export const EMAIL_EVENTS = ['queued', 'attempt_failed', 'sent', 'failed', 'skipped', 'delivered', 'delayed', 'bounced', 'complained', 'opened', 'clicked', 'provider_failed', 'suppressed'] as const;
export type EmailEventType = (typeof EMAIL_EVENTS)[number];
/** Statuses that need an administrator's attention (the e-mail did not reach the recipient). */
export const EMAIL_PROBLEM_STATUSES: readonly EmailStatus[] = ['failed', 'bounced', 'complained'];

/** Statuses the log's cards group: waiting for the worker, and did not reach the recipient. */
export const EMAIL_WAITING_STATUSES: readonly EmailStatus[] = ['queued', 'retrying'];

export const emailLogQuerySchema = paginationQuerySchema.extend({
  /** One status, or several comma-separated (`failed,bounced,complained`). */
  status: z.string().trim().max(200).optional()
    .transform((v) => (v ? [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))] : undefined))
    .pipe(z.array(z.enum(EMAIL_STATUSES)).min(1).optional()),
  kind: z.enum(EMAIL_KINDS).optional(),
  /** Part of the recipient's address or of the subject. */
  search: z.string().trim().max(200).optional(),
  invitationId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type EmailLogQuery = z.infer<typeof emailLogQuerySchema>;

export const emailLogSummaryQuerySchema = z.object({ from: isoDateTimeSchema.optional(), to: isoDateTimeSchema.optional() });
export type EmailLogSummaryQuery = z.infer<typeof emailLogSummaryQuerySchema>;

export const emailMessageDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema.nullable(),
  kind: z.enum(EMAIL_KINDS),
  /** `invitation`, or the notification type (e.g. `approval.pending`). */
  category: z.string(),
  recipient: z.string(),
  recipientUserId: uuidSchema.nullable(),
  recipientName: z.string().nullable(),
  subject: z.string().nullable(),
  status: z.enum(EMAIL_STATUSES),
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  invitationId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  lastAttemptAt: isoDateTimeSchema.nullable(),
  nextAttemptAt: isoDateTimeSchema.nullable(),
  sentAt: isoDateTimeSchema.nullable(),
  deliveredAt: isoDateTimeSchema.nullable(),
  openedAt: isoDateTimeSchema.nullable(),
  clickedAt: isoDateTimeSchema.nullable(),
  bouncedAt: isoDateTimeSchema.nullable(),
  complainedAt: isoDateTimeSchema.nullable(),
});
export type EmailMessageDto = z.infer<typeof emailMessageDtoSchema>;

export const emailEventDtoSchema = z.object({
  id: z.string(),
  event: z.enum(EMAIL_EVENTS),
  occurredAt: isoDateTimeSchema,
  attempt: z.number().int().nullable(),
  detail: z.string().nullable(),
});
export type EmailEventDto = z.infer<typeof emailEventDtoSchema>;

export const emailMessageDetailDtoSchema = emailMessageDtoSchema.extend({ events: z.array(emailEventDtoSchema) });
export type EmailMessageDetailDto = z.infer<typeof emailMessageDetailDtoSchema>;

/** How long a message may wait for the worker (queued, or past its retry time) before the log calls it stalled. */
export const EMAIL_STALLED_AFTER_MINUTES = 5;

/** The period's counts (default: the last 7 days, by the time the e-mail was queued). */
export const emailLogSummaryDtoSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  total: z.number().int(),
  byStatus: z.record(z.enum(EMAIL_STATUSES), z.number().int()),
  /** Messages waiting for the worker for more than EMAIL_STALLED_AFTER_MINUTES (whatever the period): no worker is sending. */
  stalled: z.number().int(),
  oldestStalledAt: isoDateTimeSchema.nullable(),
  /** Messages of the period "sent" by the console mailer — they never left the server (the worker has no e-mail provider). */
  consoleSent: z.number().int(),
});
export type EmailLogSummaryDto = z.infer<typeof emailLogSummaryDtoSchema>;
