import type { Context } from 'hono';
import type { PageMeta } from '@flowza/contracts';

export function ok<T>(c: Context, data: T, meta?: Record<string, unknown>, status: 200 | 201 = 200) {
  return c.json({ data, ...(meta ? { meta } : {}) }, status);
}
export function created<T>(c: Context, data: T) { return ok(c, data, undefined, 201); }
export function accepted(c: Context, jobId: string, message = 'Request queued successfully.') {
  return c.json({ data: { jobId, status: 'QUEUED' as const, message } }, 202);
}
export function paginated<T>(c: Context, data: T[], page: number, pageSize: number, total: number) {
  const meta: PageMeta = { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  return c.json({ data, meta }, 200);
}
export function noContent(c: Context) { return c.body(null, 204); }

export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) return fwd.split(',')[0]!.trim();
    const real = c.req.header('x-real-ip');
    if (real) return real;
  }
  return null;
}
