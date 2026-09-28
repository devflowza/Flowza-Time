import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AppError } from '@flowza/shared';
import { errorHandler } from './error-handler.js';
import type { AppEnv } from './request-context.js';

/** The error envelope (§51) — HR portal Prompt 5 review, P2-8: every 429 that knows when its window ends says so. */
const appThrowing = (err: unknown) => {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get('/x', () => { throw err; });
  return app;
};

describe('errorHandler', () => {
  it('5-P2-8 a quota refusal (RATE_LIMITED with retryAfterMs) carries Retry-After in whole seconds, never below 1', async () => {
    const quota = await appThrowing(new AppError('RATE_LIMITED', 'At most 30 regularisation exports per hour per organisation.', { details: { metric: 'regularisation_exports', limit: 30 }, retryAfterMs: 1_234_567 })).request('/x');
    expect(quota.status).toBe(429);
    expect(quota.headers.get('retry-after')).toBe('1235');
    expect(await quota.json()).toMatchObject({ code: 'RATE_LIMITED', details: { metric: 'regularisation_exports', limit: 30 } });
    expect((await appThrowing(new AppError('RATE_LIMITED', 'Soon.', { retryAfterMs: 10 })).request('/x')).headers.get('retry-after')).toBe('1');
    expect((await appThrowing(new AppError('RATE_LIMITED', 'Late.', { retryAfterMs: -5 })).request('/x')).headers.get('retry-after')).toBe('1');
  });

  it('5-P2-8 no header when the refusal does not know its window, nor on other statuses', async () => {
    expect((await appThrowing(new AppError('RATE_LIMITED', 'No window.')).request('/x')).headers.get('retry-after')).toBeNull();
    const conflict = await appThrowing(new AppError('CONFLICT', 'Busy.', { retryable: true, retryAfterMs: 5_000 })).request('/x');
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('retry-after')).toBeNull();
  });
});
