import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError, toAppError } from '@flowza/shared';
import type { AppEnv } from './request-context.js';

/** Maps any error to the standard envelope { code, message, requestId, details? } (§51). */
export function errorHandler(err: unknown, c: Context<AppEnv>) {
  const requestId = c.get('requestId') ?? 'unknown';
  const log = c.get('log');
  if (err instanceof ZodError) {
    const details = { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request validation failed.', requestId, details }, 400);
  }
  if (err instanceof HTTPException) {
    const code = err.status === 404 ? 'NOT_FOUND' : err.status === 401 ? 'UNAUTHENTICATED' : err.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_STATE';
    return c.json({ code, message: err.message || 'Request failed.', requestId }, err.status);
  }
  const appErr = AppError.is(err) ? (err as AppError) : toAppError(err);
  if (appErr.status >= 500) {
    log?.error({ event: 'unhandled_error', err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err });
  } else {
    log?.warn({ event: 'request_error', code: appErr.code, message: appErr.message });
  }
  // Postgres RLS / constraint violations surface as generic conflicts, never as SQL text
  const body = appErr.toJSON(requestId);
  if (appErr.status >= 500) body.message = 'An unexpected error occurred.';
  return c.json(body, appErr.status as 400);
}

/** Translate common pg error codes to AppErrors inside services. */
export function mapPgError(err: unknown): AppError | null {
  const code = (err as { code?: string })?.code;
  const detail = (err as { detail?: string; constraint?: string })?.constraint;
  switch (code) {
    case '23505': return new AppError('CONFLICT', 'A record with the same unique value already exists.', { details: detail ? { constraint: detail } : undefined });
    case '23503': return new AppError('VALIDATION_ERROR', 'A referenced record does not exist or belongs to another organisation.', { details: detail ? { constraint: detail } : undefined });
    case '23514': return new AppError('VALIDATION_ERROR', 'A value violates a business rule.', { details: detail ? { constraint: detail } : undefined });
    case '23P01': return new AppError('CONFLICT', 'The date range overlaps an existing record.', { details: detail ? { constraint: detail } : undefined });
    case '42501': return new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    case '22023': return new AppError('VALIDATION_ERROR', (err as Error).message.replace(/^error:\s*/i, '') || 'Invalid parameter value.');
    case '22P02': return new AppError('VALIDATION_ERROR', 'A value has an invalid format.');
    case '22001': return new AppError('VALIDATION_ERROR', 'A value is too long.');
    case '22007': case '22008': return new AppError('VALIDATION_ERROR', 'Invalid date or time value.');
    case '23502': return new AppError('VALIDATION_ERROR', 'A required value is missing.', { details: (err as { column?: string }).column ? { column: (err as { column?: string }).column } : undefined });
    case '40001': case '40P01': return new AppError('CONFLICT', 'The operation conflicted with a concurrent change. Please retry.', { retryable: true });
    case 'P0002': return new AppError('PERIOD_LOCKED', 'The attendance period is locked.');
    case 'P0001': return new AppError('INVALID_STATE', (err as Error).message.replace(/^error:\s*/i, ''));
    default: return null;
  }
}
