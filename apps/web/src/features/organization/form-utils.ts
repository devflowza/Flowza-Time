/** RHF `setValueAs` helpers so optional text inputs submit `undefined` (not '') and numeric inputs submit numbers. */
export const blankToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
export const blankToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
export const toOptionalNumber = (v: unknown): unknown => (v === '' || v === null || v === undefined ? undefined : Number(v));
export const toNumber = (v: unknown): unknown => (v === '' || v === null || v === undefined ? undefined : Number(v));
/** Sentinel for Radix Select "none" items (Radix forbids empty string item values). */
export const NONE = '__none__';
export const fromSelect = (v: string): string | null => (v === NONE ? null : v);
export const toSelect = (v: string | null | undefined): string => (v === null || v === undefined || v === '' ? NONE : v);
