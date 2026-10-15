// FlowZa Time · portal videos · a minimal LOCAL Supabase Auth (GoTrue) double, so the real web app and the real API can run on
// the local Postgres without Docker (docs/development.md: the local shim has no Auth server). The password grant is checked
// against auth.users (bcrypt via pgcrypto) and the session is an HS256 token signed with SUPABASE_JWT_SECRET, which the API
// verifies (apps/api/src/lib/jwt.ts, legacy HS256 path). Development / recording only — never deployed, never pointed at a
// hosted database. Usage: SUPABASE_JWT_SECRET=… DATABASE_URL_ADMIN=… node local-auth.mjs   (listens on 127.0.0.1:54321)
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve(process.env.REPO ?? process.cwd(), 'apps/api/package.json'));
const pg = require('pg');

const PORT = Number(process.env.PORT ?? 54321);
const SECRET = process.env.SUPABASE_JWT_SECRET;
if (!SECRET || SECRET.length < 32) throw new Error('set SUPABASE_JWT_SECRET (≥ 32 characters) — the same value the API verifies with');
const ISS = `http://127.0.0.1:${PORT}/auth/v1`;
const DB = process.env.DATABASE_URL_ADMIN ?? 'postgres://postgres@127.0.0.1:54329/flowza';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) throw new Error('local-auth only runs against a local database');
const pool = new pg.Pool({ connectionString: DB, max: 3 });
const refresh = new Map(); // refresh token -> user id

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function sign(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(payload);
  const s = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
async function userRow(id) {
  const r = await pool.query('select id, email, raw_user_meta_data, created_at, last_sign_in_at from auth.users where id = $1', [id]);
  return r.rows[0];
}
function userBody(u) {
  return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.raw_user_meta_data ?? {}, identities: [], created_at: u.created_at, updated_at: new Date().toISOString(), last_sign_in_at: u.last_sign_in_at, factors: [] };
}
function session(u) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 8 * 3600;
  const access = sign({ iss: ISS, sub: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, aal: 'aal1', amr: [{ method: 'password', timestamp: iat }], session_id: crypto.randomUUID(), iat, exp });
  const rt = crypto.randomBytes(16).toString('hex');
  refresh.set(rt, u.id);
  return { access_token: access, token_type: 'bearer', expires_in: exp - iat, expires_at: exp, refresh_token: rt, user: userBody(u) };
}
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); res.end(body === undefined ? '' : JSON.stringify(body)); }
function readBody(req) { return new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } }); }); }
function bearerUser(req) {
  const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub; } catch { return null; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204);
  try {
    if (url.pathname.endsWith('/.well-known/jwks.json')) return send(res, 200, { keys: [] });
    if (url.pathname.endsWith('/token')) {
      const body = await readBody(req);
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const r = await pool.query('select id from auth.users where lower(email) = lower($1) and encrypted_password = extensions.crypt($2, encrypted_password)', [body.email, body.password]);
        if (!r.rows[0]) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        await pool.query('update auth.users set last_sign_in_at = now() where id = $1', [r.rows[0].id]);
        return send(res, 200, session(await userRow(r.rows[0].id)));
      }
      if (grant === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return send(res, 200, session(await userRow(id)));
      }
      return send(res, 400, { msg: 'unsupported grant' });
    }
    if (url.pathname.endsWith('/user')) {
      const id = bearerUser(req);
      const u = id && (await userRow(id));
      if (!u) return send(res, 401, { msg: 'no user' });
      return send(res, 200, userBody(u));
    }
    if (url.pathname.endsWith('/logout')) return send(res, 204);
    if (url.pathname.endsWith('/factors')) return send(res, 200, { totp: [], all: [] });
    if (url.pathname.includes('/admin/')) return send(res, 200, { users: [] });
    return send(res, 404, { msg: `stub: ${url.pathname}` });
  } catch (e) {
    console.error(e);
    return send(res, 500, { msg: String(e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`gotrue stub on ${PORT}`));
