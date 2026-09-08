import type { Browser } from 'playwright-core';
import { AppError, event, type Logger } from '@flowza/shared';
import type { WorkerConfig } from '../config.js';
import type { PdfRenderer, PdfRenderOptions } from '../deps.js';

const DEFAULT_MARGIN = { top: 16, right: 12, bottom: 18, left: 12 };

/**
 * Headless Chromium PDF renderer (playwright-core driving the Chromium that apps/worker/Dockerfile.reports installs).
 *
 * Why Chromium rather than a JS PDF library: the sample layouts are print documents — repeated table headers,
 * landscape pages, running footers with "Page X of Y", colour-coded codes — and the product ships in Arabic, whose
 * shaping and bidi a browser engine gets right for free. Everything is therefore an HTML template.
 *
 * One browser per process, launched on first use and reused; each render gets its own context so a failed page never
 * poisons the next. Without CHROMIUM_PATH the renderer refuses immediately and non-retryably: this worker was not
 * built to render PDF (the general worker), and retrying would only delay the FAILED status the requester needs to see.
 */
export function createPdfRenderer(config: WorkerConfig, log: Logger): PdfRenderer {
  const executablePath = config.CHROMIUM_PATH;
  let browser: Promise<Browser> | null = null;

  const launch = async (): Promise<Browser> => {
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'] });
    b.on('disconnected', () => { browser = null; log.warn(event('pdf_browser_disconnected')); });
    log.info(event('pdf_browser_started', { executablePath }));
    return b;
  };

  return {
    async render(html: string, opts: PdfRenderOptions): Promise<Buffer> {
      if (!executablePath) throw new AppError('DEPENDENCY_UNAVAILABLE', 'PDF rendering is not available on this worker; request the report as CSV or XLSX, or run it on the reports worker.', { retryable: false });
      browser ??= launch().catch((err: unknown) => { browser = null; throw new AppError('DEPENDENCY_UNAVAILABLE', 'The PDF renderer failed to start.', { cause: err, retryable: true }); });
      const b = await browser;
      const context = await b.newContext({ javaScriptEnabled: false });
      try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
        const m = opts.marginMm ?? DEFAULT_MARGIN;
        const pdf = await page.pdf({
          format: 'A4',
          landscape: opts.landscape,
          printBackground: true,
          preferCSSPageSize: false,
          displayHeaderFooter: !!(opts.headerHtml || opts.footerHtml),
          headerTemplate: opts.headerHtml ?? '<span></span>',
          footerTemplate: opts.footerHtml ?? '<span></span>',
          margin: { top: `${m.top}mm`, right: `${m.right}mm`, bottom: `${m.bottom}mm`, left: `${m.left}mm` },
        });
        return Buffer.from(pdf);
      } finally {
        await context.close().catch(() => undefined);
      }
    },
  };
}
