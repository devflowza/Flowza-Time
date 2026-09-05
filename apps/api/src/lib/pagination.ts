import { errors } from '@flowza/shared';

export interface Page { page: number; pageSize: number; offset: number }

export function pageOf(q: { page: number; pageSize: number }): Page {
  return { page: q.page, pageSize: q.pageSize, offset: (q.page - 1) * q.pageSize };
}

export type SortDirection = 'asc' | 'desc';
export interface ResolvedSort<C extends string> { column: C; direction: SortDirection }

/**
 * Resolve a client-provided sort key against an allow-list (client key → SQL column reference).
 * Unknown keys are a 400 — never interpolate client strings into ORDER BY.
 */
export function resolveSort<C extends string>(allowed: Record<string, C>, sort: string | undefined, order: SortDirection, fallback: C): ResolvedSort<C> {
  if (!sort) return { column: fallback, direction: order };
  const column = allowed[sort];
  if (!column) throw errors.validation(`Unsupported sort key "${sort}".`, { allowed: Object.keys(allowed) });
  return { column, direction: order };
}

/** Escape LIKE wildcards in user input and wrap for a contains match. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Build a prefix-matching tsquery string ("ali sa" → "ali:* & sa:*"), safe for to_tsquery('simple', …). */
export function prefixTsQuery(term: string): string | null {
  const tokens = term.toLowerCase().split(/[^\p{L}\p{N}_@.-]+/u).map((t) => t.replace(/[':*&|!()<>\\]/g, '')).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `'${t}':*`).join(' & ');
}

export function toCount(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}
