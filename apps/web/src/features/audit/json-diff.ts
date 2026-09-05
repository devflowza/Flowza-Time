/** Pure helpers for the audit old/new comparison. Kept free of React so they can be unit-tested. */
export type Json = unknown;

export function prettyJson(value: Json): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
  return JSON.stringify(value, null, 2);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Top-level keys whose value differs between old and new (deep-equal by JSON serialisation). */
export function changedKeys(oldValue: Json, newValue: Json): Set<string> {
  const out = new Set<string>();
  if (!isRecord(oldValue) && !isRecord(newValue)) return out;
  const a = isRecord(oldValue) ? oldValue : {};
  const b = isRecord(newValue) ? newValue : {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.add(k);
  return out;
}

export interface DiffLine { text: string; changed: boolean }

/** Pretty-printed lines; lines belonging to a changed top-level key are flagged so the UI can highlight them. */
export function diffLines(value: Json, changed: Set<string>): DiffLine[] {
  const text = prettyJson(value);
  if (!text) return [];
  let currentKey: string | null = null;
  return text.split('\n').map((line) => {
    const m = /^ {2}"([^"]+)":/.exec(line); // top-level key at indent 2
    if (m) currentKey = m[1] ?? null;
    else if (/^[}\]]/.test(line)) currentKey = null;
    return { text: line, changed: currentKey !== null && changed.has(currentKey) };
  });
}
