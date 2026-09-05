import { describe, expect, it } from 'vitest';
import { MAX_RECALC_DAYS, recalcChunks } from './recalc.js';

describe('recalcChunks', () => {
  it('keeps a range within the request limit as ONE chunk', () => {
    expect(recalcChunks('2026-01-01', '2026-01-01')).toEqual([{ fromDate: '2026-01-01', toDate: '2026-01-01' }]);
    expect(recalcChunks('2025-01-01', '2026-01-02')).toEqual([{ fromDate: '2025-01-01', toDate: '2026-01-02' }]); // exactly 366 days
  });
  it('splits longer ranges into consecutive, non-overlapping chunks of at most MAX_RECALC_DAYS days', () => {
    const chunks = recalcChunks('2024-01-01', '2026-09-05');
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toEqual({ fromDate: '2024-01-01', toDate: '2025-01-01' });
    expect(chunks[1]!.fromDate).toBe('2025-01-02');
    expect(chunks[chunks.length - 1]!.toDate).toBe('2026-09-05');
    for (const c of chunks) expect((Date.parse(c.toDate) - Date.parse(c.fromDate)) / 86_400_000).toBeLessThanOrEqual(MAX_RECALC_DAYS);
    for (let i = 1; i < chunks.length; i += 1) expect(Date.parse(chunks[i]!.fromDate) - Date.parse(chunks[i - 1]!.toDate)).toBe(86_400_000);
  });
});
