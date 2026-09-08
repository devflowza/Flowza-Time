import { describe, expect, it } from 'vitest';
import { createLogger, AppError } from '@flowza/shared';
import type { WorkerConfig } from '../config.js';
import { createPdfRenderer } from './pdf.js';

const log = createLogger({ name: 'pdf-test', level: 'silent' });
const config = (chromiumPath: string | undefined) => ({ CHROMIUM_PATH: chromiumPath } as unknown as WorkerConfig);

describe('createPdfRenderer', () => {
  it('refuses non-retryably on a worker built without Chromium, so a PDF request fails visibly instead of retrying', async () => {
    const r = createPdfRenderer(config(undefined), log);
    await expect(r.render('<html><body>x</body></html>', { landscape: false })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: false });
    await expect(r.render('<html></html>', { landscape: false })).rejects.toBeInstanceOf(AppError);
  });

  // The real renderer: exercised where a Chromium is available (CI installs one for this job; the reports image ships one).
  describe.skipIf(!process.env.CHROMIUM_PATH)('with Chromium', () => {
    it('renders an HTML document to a PDF with the footer template', async () => {
      const r = createPdfRenderer(config(process.env.CHROMIUM_PATH), log);
      const pdf = await r.render('<!doctype html><html dir="rtl" lang="ar"><body><h1>تقرير</h1><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></body></html>', { landscape: true, footerHtml: '<span class="pageNumber"></span>' });
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1500);
    }, 60_000);
  });
});
