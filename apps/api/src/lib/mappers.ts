/** Shared row → DTO helpers. Kysely returns timestamptz as Date and `date` columns as Date at local midnight. */
export function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
export function isoDateTimeOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : isoDateTime(value);
}
export function isoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getFullYear(); const m = String(value.getMonth() + 1).padStart(2, '0'); const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export function isoDateOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : isoDate(value);
}
export function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
export function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') { try { const p = JSON.parse(value); return p && typeof p === 'object' ? (p as Record<string, unknown>) : {}; } catch { return {}; } }
  return {};
}
export function jsonArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') { try { const p = JSON.parse(value); return Array.isArray(p) ? (p as T[]) : []; } catch { return []; } }
  return [];
}
/** Group rows by a key for batch (non-N+1) lookups. */
export function groupBy<T, K extends string>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) { const k = key(r); const arr = out.get(k); if (arr) arr.push(r); else out.set(k, [r]); }
  return out;
}
export function indexBy<T, K extends string>(rows: readonly T[], key: (row: T) => K): Map<K, T> {
  return new Map(rows.map((r) => [key(r), r]));
}
