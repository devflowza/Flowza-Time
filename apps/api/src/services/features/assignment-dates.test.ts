import { describe, expect, it } from 'vitest';
import { assignmentEndFromStored, assignmentEndToStored } from './assignment-dates.js';

describe('shift assignment last day ↔ stored bound', () => {
  it('stores the day after the last day (half-open [from, to)) and reads it back as the last day', () => {
    expect(assignmentEndToStored('2026-09-02')).toBe('2026-09-03');
    expect(assignmentEndToStored('2026-09-30')).toBe('2026-10-01');
    expect(assignmentEndToStored('2026-12-31')).toBe('2027-01-01');
    expect(assignmentEndFromStored('2026-10-02')).toBe('2026-10-01');
    expect(assignmentEndFromStored(assignmentEndToStored('2026-02-28'))).toBe('2026-02-28');
  });

  it('keeps an open end open', () => {
    expect(assignmentEndToStored(null)).toBeNull();
    expect(assignmentEndToStored(undefined)).toBeNull();
    expect(assignmentEndFromStored(null)).toBeNull();
  });
});
