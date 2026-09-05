import type { Context, Hono } from 'hono';
import { importJobListQuerySchema, importJobRowsQuerySchema, importUploadSchema } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { accepted, created, ok, paginated } from '../../lib/http.js';
import { param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { idempotency } from '../../middleware/idempotency.js';
import * as imports from '../../services/imports.service.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Accepts multipart/form-data (field `file`, optional `options` JSON) or JSON { fileName, contentBase64, options }. */
async function readUpload(c: Context<AppEnv>): Promise<{ fileName: string; content: string; options: { updateExisting?: boolean; autoAssignDeviceUserId?: boolean } }> {
  const ctx = c;
  const contentType = ctx.req.header('content-type') ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    const form = await ctx.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) throw errors.validation('Missing file field.', { issues: [{ path: 'file', message: 'Required' }] });
    if (file.size > MAX_UPLOAD_BYTES) throw errors.validation('File too large (max 20 MB).');
    const rawOptions = typeof form['options'] === 'string' ? JSON.parse(form['options'] as string) : {};
    const options = importUploadSchema.shape.options.parse(rawOptions);
    return { fileName: file.name || 'import.csv', content: await file.text(), options };
  }
  const body = importUploadSchema.parse(await ctx.req.json().catch(() => ({})));
  const buf = Buffer.from(body.contentBase64, 'base64');
  if (buf.byteLength > MAX_UPLOAD_BYTES) throw errors.validation('File too large (max 20 MB).');
  return { fileName: body.fileName, content: buf.toString('utf8'), options: body.options };
}

export function registerImportRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/employees/imports/template', (c) => {
    actorOf(c, deps);
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', 'attachment; filename="employees-import-template.csv"');
    return c.body(imports.templateCsv());
  });
  v1.get('/orgs/:orgId/employees/imports', async (c) => {
    const q = query(c, importJobListQuerySchema);
    const { data, total } = await imports.listImports(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });
  v1.post('/orgs/:orgId/employees/imports', idem, async (c) => created(c, await imports.createImport(deps, actorOf(c, deps), param(c, 'orgId'), await readUpload(c))));
  v1.get('/orgs/:orgId/employees/imports/:id', async (c) => {
    const q = query(c, importJobRowsQuerySchema);
    const { job, rows, total } = await imports.getImport(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), q);
    return c.json({ data: { ...job, rows }, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) } });
  });
  v1.post('/orgs/:orgId/employees/imports/:id/confirm', idem, async (c) => {
    const r = await imports.confirmImport(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'));
    return accepted(c, r.jobId, 'Import queued.');
  });
  v1.post('/orgs/:orgId/employees/imports/:id/cancel', async (c) => ok(c, await imports.cancelImport(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}
