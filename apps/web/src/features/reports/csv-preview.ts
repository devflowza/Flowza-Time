/**
 * A report CSV read back for the in-app viewer (RFC 4180: quoted fields, doubled quotes, CR/LF, a leading BOM). The worker's
 * CSV escapes formula-leading cells with a leading apostrophe; the preview shows the cell as stored, it never evaluates anything.
 * Stops after `maxRows` rows — the viewer is a preview, the download is the file.
 */
export function parseCsv(text: string, maxRows = 500): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => { row.push(field); field = ''; rows.push(row); row = []; };
  for (; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { if (text[i + 1] === '\n') i += 1; endRow(); }
    else if (ch === '\n') endRow();
    else field += ch;
    if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true };
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, truncated: false };
}
