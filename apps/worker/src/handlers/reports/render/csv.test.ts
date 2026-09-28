import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import type { ReportDocument } from '../model.js';
import { escapeSpreadsheetText, renderCsv } from './csv.js';

/**
 * Security gate (HR portal Prompt 10): a generated CSV report never hands a spreadsheet a formula. An employee named
 * "=HYPERLINK(…)", a department called "@Ops" or a column header starting with "+" stays text; numbers stay numbers.
 */
describe('CSV report renderer — formula injection', () => {
  it('prefixes every text cell a spreadsheet would evaluate — header, group heading and data — and leaves numbers alone', () => {
    const doc = {
      columns: [{ key: 'name', label: '+Name' }, { key: 'late', label: 'Late days' }, { key: 'note', label: 'Note' }],
      sections: [{
        heading: { label: 'Dept', value: '@Ops' },
        rows: [
          { cells: [{ text: '=HYPERLINK("http://evil.test","x")' }, { text: '-3', number: -3 }, { text: '\tcmd' }] },
          { cells: [{ text: '-2+3' }, { text: '2', number: 2 }, { text: '\rcalc' }] },
          { kind: 'total', cells: [{ text: '=SUM(B2:B3)' }, { text: '-1', number: -1 }, { text: '' }] },
        ],
      }],
      flatten: { headingColumnLabel: '=Dept', fieldColumns: false },
    } as unknown as ReportDocument;
    const buf = renderCsv(doc);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM (Excel opens Arabic correctly)
    const parsed = Papa.parse<string[]>(buf.subarray(3).toString('utf8'), { skipEmptyLines: true });
    const [header, ...rows] = parsed.data;
    expect(header).toEqual(['\'=Dept', '\'+Name', 'Late days', 'Note']);
    expect(rows).toEqual([
      ['\'@Ops', '\'=HYPERLINK("http://evil.test","x")', '-3', '\'\tcmd'],
      ['\'@Ops', '\'-2+3', '2', '\'\rcalc'],
    ]); // the total row is dropped: a sheet recomputes it
    for (const row of [header!, ...rows]) for (const cell of row) if (!/^-?\d+(\.\d+)?$/.test(cell)) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });

  it('escapes the six formula-leading characters and nothing else', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) expect(escapeSpreadsheetText(`${lead}1`)).toBe(`'${lead}1`);
    for (const plain of ['Ahmed Al-Balushi', '1', ' =1', 'a=b', '']) expect(escapeSpreadsheetText(plain)).toBe(plain);
  });
});
