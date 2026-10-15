// FlowZa Time · portal videos · pending requests filed THROUGH THE API (after demo-seed.sql), so they reach the approvals inbox
// exactly as the portal files them: a planned official visit and a personal permission (time away), annual leave, a shift swap.
// Usage: node seed-requests.mjs   (env: AUTH_URL default http://127.0.0.1:54321, API_URL default http://localhost:4000)
const AUTH = process.env.AUTH_URL ?? 'http://127.0.0.1:54321';
const API = process.env.API_URL ?? 'http://localhost:4000';
const ORG = '00000000-0000-4000-a000-000000000001';
const PASSWORD = 'FlowZa-Demo-2026!';

async function login(email) {
  const res = await fetch(`${AUTH}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  return (await res.json()).access_token;
}
async function call(token, method, path, body) {
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.warn(`  ${method} ${path} → ${res.status} ${json.code ?? ''} ${json.message ?? ''}`); return null; }
  return json.data ?? json;
}
const at = (date, time) => new Date(`${date}T${time}:00+04:00`).toISOString();

const ahmed = await login('employee@albahja.example');
const huda = await login('huda@albahja.example');
const yousuf = await login('yousuf@albahja.example');

const types = await call(ahmed, 'GET', `/orgs/${ORG}/me/leave?year=2026`);
const annual = types?.balances?.find?.((b) => b.leaveTypeCode === 'ANNUAL' || b.code === 'ANNUAL')?.leaveTypeId
  ?? types?.types?.find?.((t) => t.code === 'ANNUAL')?.id;
console.log('annual leave type', annual ?? '(not found — leave request skipped)');

console.log('time away: Ahmed — planned official visit (Sun 18 Oct 10:00–12:00)');
await call(ahmed, 'POST', `/orgs/${ORG}/me/time-away`, { kind: 'OFFICIAL', startsAt: at('2026-10-18', '10:00'), endsAt: at('2026-10-18', '12:00'), reason: 'Ministry of Commerce — trade licence renewal for QA lab', destination: 'Ministry of Commerce, Al Khuwair' });
console.log('time away: Huda — personal permission (Mon 19 Oct 15:00–16:00)');
await call(huda, 'POST', `/orgs/${ORG}/me/time-away`, { kind: 'PERSONAL', startsAt: at('2026-10-19', '15:00'), endsAt: at('2026-10-19', '16:00'), reason: 'Parent–teacher meeting at school' });
console.log('time away: Yousuf — official duty (Mon 19 Oct 09:30–11:30)');
await call(yousuf, 'POST', `/orgs/${ORG}/me/time-away`, { kind: 'OFFICIAL', startsAt: at('2026-10-19', '09:30'), endsAt: at('2026-10-19', '11:30'), reason: 'Calibration certificates — Directorate of Standards', destination: 'DGSM, Ruwi' });

if (annual) {
  console.log('leave: Ahmed — annual leave 2–4 Nov');
  await call(ahmed, 'POST', `/orgs/${ORG}/me/leave`, { leaveTypeId: annual, startDate: '2026-11-02', endDate: '2026-11-04', reason: 'Family visit to Nizwa' });
  console.log('leave: Yousuf — annual leave 9 Nov');
  await call(yousuf, 'POST', `/orgs/${ORG}/me/leave`, { leaveTypeId: annual, startDate: '2026-11-09', endDate: '2026-11-09', reason: 'Personal errand' });
}

console.log('swap: Huda asks Ahmed to swap Mon 26 Oct (12:00–18:00 ↔ 08:00–14:00)');
const hudaMe = await call(huda, 'GET', `/me`);
const candidates = await call(huda, 'GET', `/orgs/${ORG}/me/shift-swaps/candidates?date=2026-10-26&search=Ahmed`);
const target = (candidates ?? []).find((c) => c.displayName === 'Ahmed Al Hinai');
if (target) await call(huda, 'POST', `/orgs/${ORG}/me/shift-swaps`, { date: '2026-10-26', withEmployeeId: target.employeeId, reason: 'Doctor appointment in the afternoon — I can cover the morning' });
else console.warn('  swap candidate not found', hudaMe ? '' : '(huda /me failed)');
console.log('report schedule: HR — "Morning roll call", the Daily Report to the managers every working morning (Sun–Thu 07:30)');
const hr = await login('hr@albahja.example');
const managers = (await call(hr, 'GET', `/orgs/${ORG}/report-recipients`))?.users?.filter?.((u) => ['manager@albahja.example', 'head@albahja.example'].includes(u.email)).map((u) => u.userId ?? u.id) ?? [];
const schedule = await call(hr, 'POST', `/orgs/${ORG}/report-schedules`, {
  name: 'Morning roll call', reportType: 'daily_attendance', format: 'csv', filters: {}, cadence: 'daily', runDay: 0b0011111, runTime: '07:30',
  periodRule: 'previous_day', recipients: { userIds: managers, roleKeys: managers.length ? [] : ['line_manager'] }, channels: ['in_app', 'email'], isActive: true,
});
if (schedule) await call(hr, 'POST', `/orgs/${ORG}/report-schedules/${schedule.id}/run-now`);
console.log('done');
