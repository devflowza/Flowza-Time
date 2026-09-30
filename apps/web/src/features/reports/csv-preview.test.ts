import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv-preview';

describe('parseCsv — the report viewer\'s CSV preview', () => {
  it('reads quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    const text = '﻿Department,Name,Remarks\r\nSales,"Al Harthy, Ahmed","said ""hi""\nthen left"\r\n,\'=SUM(A1),\n';
    expect(parseCsv(text)).toEqual({ rows: [['Department', 'Name', 'Remarks'], ['Sales', 'Al Harthy, Ahmed', 'said "hi"\nthen left'], ['', "'=SUM(A1)", '']], truncated: false });
  });
  it('stops after maxRows and says so', () => {
    const text = Array.from({ length: 10 }, (_, i) => `r${i},x`).join('\n');
    const r = parseCsv(text, 3);
    expect(r.truncated).toBe(true);
    expect(r.rows).toEqual([['r0', 'x'], ['r1', 'x'], ['r2', 'x']]);
  });
  it('an empty file is no rows', () => {
    expect(parseCsv('')).toEqual({ rows: [], truncated: false });
  });
});
