"""Viewer assets for the generated reports: every page as a 300 dpi PNG, a manifest for viewer.html, and the position of
every printed word (PDF points, from pdftotext -bbox) so the recording can box columns and rows exactly.

usage: python3 -I prep_media.py <reports_dir> <media_dir>
"""
import html, json, os, re, subprocess, sys

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
# key → (PDF made by gen-reports.ts, file name the API gives the download: <report type>-<generated date>.pdf)
REPORTS = {
    'monthly': ('monthly-attendance-detailed-2026-09.pdf', 'monthly_attendance-2026-10-13.pdf'),
    'yearly': ('detail-report-2025.pdf', 'employee_attendance-2026-10-13.pdf'),
}
for key, (pdf, file_name) in REPORTS.items():
    path = os.path.join(src, pdf)
    subprocess.run(['pdftoppm', '-r', '300', '-png', path, os.path.join(out, key)], check=True)
    pngs = sorted(f for f in os.listdir(out) if re.fullmatch(rf'{key}-\d+\.png', f))
    bbox = subprocess.run(['pdftotext', '-bbox', path, '-'], check=True, capture_output=True, text=True).stdout
    pages = re.findall(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', bbox, re.S)
    words = []
    for i, (_, _, body) in enumerate(pages):
        for x0, y0, x1, y1, t in re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', body):
            words.append({'p': i, 'x': float(x0), 'y': float(y0), 'w': float(x1) - float(x0), 'h': float(y1) - float(y0), 't': html.unescape(t)})
    manifest = {'fileName': file_name, 'widthPt': float(pages[0][0]), 'heightPt': float(pages[0][1]), 'pages': [f'/__media/{p}' for p in pngs]}
    json.dump(manifest, open(os.path.join(out, f'{key}.json'), 'w'), indent=1)
    json.dump(words, open(os.path.join(out, f'{key}.words.json'), 'w'))
    print(key, len(pngs), 'pages', len(words), 'words')
