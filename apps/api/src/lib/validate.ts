import type { Context } from 'hono';
import type { z } from 'zod';

/** Parse and validate JSON body / query / params with shared Zod schemas; ZodError → 400 via errorHandler. */
export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const json = await c.req.json().catch(() => ({}));
  return schema.parse(json);
}
export function query<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  const q: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(c.req.queries())) q[k] = v.length === 1 ? v[0]! : v;
  return schema.parse(q);
}
export function param(c: Context, name: string): string {
  const v = c.req.param(name);
  if (!v) throw new Error(`missing route param ${name}`);
  return v;
}
