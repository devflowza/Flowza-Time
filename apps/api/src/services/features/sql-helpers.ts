import { sql, type RawBuilder } from 'kysely';

/** Typed `date` operand for Kysely comparisons against `date` columns (their select type is Date, inputs are ISO strings). */
export const dv = (value: string): RawBuilder<Date> => sql<Date>`${value}::date`;
/** `current_date` as a typed operand. */
export const today = (): RawBuilder<Date> => sql<Date>`current_date`;
