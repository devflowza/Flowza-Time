import assert from 'node:assert/strict';
import { CAPABILITY_KEYS, rawTransactionSchema, type DeviceCapabilities, type DeviceEmployee } from '@flowza/contracts';
import { secretFieldsOf } from './definition.js';
import { ProviderError, type AttendancePullResult, type DeviceProvider, type ProviderContext } from './types.js';

/**
 * Shared conformance suite (§L.4). Runner-agnostic: assertions use node:assert so this module can be exported
 * from the package without dragging vitest into runtime consumers. Pass `{ describe, it }` from your test runner
 * (or enable vitest globals) — the default reads them from globalThis.
 */
export interface ConformanceTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
}
export interface ConformanceSubject {
  provider: DeviceProvider;
  ctx: ProviderContext;
  /** Employee used for the upsert/list/delete round trip (default: a synthetic one). */
  sampleEmployee?: DeviceEmployee;
  /** Upper bound on pages followed while checking `hasMore` (default 20). */
  maxPages?: number;
}
export type ConformanceFactory = () => ConformanceSubject | Promise<ConformanceSubject>;

const DEFAULT_EMPLOYEE: DeviceEmployee = { deviceUserId: 'CONF-1', name: 'Conformance Tester', cardNumber: null, pin: null, privilege: 'user', enabled: true, photoUrl: null, extra: {} };

function globalApi(): ConformanceTestApi {
  const g = globalThis as { describe?: ConformanceTestApi['describe']; it?: ConformanceTestApi['it'] };
  if (typeof g.describe !== 'function' || typeof g.it !== 'function') {
    throw new Error('describeProviderConformance: pass { describe, it } from your test runner (vitest globals are not enabled)');
  }
  return { describe: g.describe, it: g.it };
}

/** Awaits `fn` and asserts it rejected with a ProviderError; returns the error. */
export async function expectProviderError(fn: () => Promise<unknown>, what: string): Promise<ProviderError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(ProviderError.is(e), `${what} must reject with a ProviderError, got ${e instanceof Error ? e.name : typeof e}`);
    return e;
  }
  assert.fail(`${what} must reject, but it succeeded`);
}

/** Capability → operation that must NOT succeed when the capability is declared false. */
type Gate = { capability: keyof DeviceCapabilities; name: string; call: (p: DeviceProvider, ctx: ProviderContext, employee: DeviceEmployee) => Promise<unknown> | undefined };
const GATES: Gate[] = [
  { capability: 'attendancePull', name: 'pullAttendance', call: (p, ctx) => p.pullAttendance(ctx, null) },
  { capability: 'employeePull', name: 'listEmployees', call: (p, ctx) => p.listEmployees(ctx, null) },
  { capability: 'employeePush', name: 'upsertEmployee', call: (p, ctx, e) => p.upsertEmployee(ctx, e) },
  { capability: 'employeeDelete', name: 'deleteEmployee', call: (p, ctx, e) => p.deleteEmployee(ctx, e.deviceUserId) },
  { capability: 'remoteRestart', name: 'restart', call: (p, ctx) => p.restart?.(ctx) },
];

const stable = (r: AttendancePullResult): unknown => ({ transactions: r.transactions, nextCursor: r.nextCursor, hasMore: r.hasMore });

export function describeProviderConformance(name: string, factory: ConformanceFactory, api: ConformanceTestApi = globalApi()): void {
  api.describe(`provider conformance: ${name}`, () => {
    api.it('has a consistent definition', async () => {
      const { provider } = await factory();
      const d = provider.definition;
      assert.match(d.key, /^[a-z][a-z0-9_]{1,63}$/);
      assert.ok(d.vendor.length > 0 && d.name.length > 0);
      for (const k of CAPABILITY_KEYS) assert.equal(typeof d.capabilities[k], 'boolean', `capability ${k} must be boolean`);
      assert.deepEqual([...d.secretFields].sort(), [...secretFieldsOf(d.configSchema)].sort(), 'secretFields must be derived from configSchema');
      for (const [k, v] of Object.entries(d.throttling)) assert.ok(Number.isInteger(v) && (v as number) >= 1, `throttling.${k} must be a positive integer`);
      if (d.integrationType === 'DEVICE_PUSH') assert.ok(d.capabilities.devicePush, 'DEVICE_PUSH providers must declare devicePush');
      if (!d.capabilities.devicePush) assert.equal(provider.pushProtocol, undefined, 'pushProtocol must be absent when devicePush is false');
      if (provider.pushProtocol) assert.match(provider.pushProtocol.protocolKey, /^[a-z][a-z0-9_-]{0,31}$/);
      if (d.status === 'placeholder') assert.notEqual(d.verificationStatus, 'VERIFIED', 'placeholders cannot claim VERIFIED');
    });

    api.it('never succeeds for a capability declared false', async () => {
      const { provider, ctx, sampleEmployee = DEFAULT_EMPLOYEE } = await factory();
      for (const gate of GATES) {
        if (provider.definition.capabilities[gate.capability]) continue;
        const call = gate.call(provider, ctx, sampleEmployee);
        if (call === undefined) continue; // optional method absent = honest
        await expectProviderError(() => call, `${gate.name} with ${gate.capability}=false`);
      }
    });

    api.it('only ever fails with ProviderError', async () => {
      const { provider, ctx, sampleEmployee = DEFAULT_EMPLOYEE } = await factory();
      const calls: Array<() => Promise<unknown>> = [
        () => provider.testConnection(ctx), () => provider.getDeviceInfo(ctx), () => provider.getCapabilities(ctx), () => provider.getDeviceStatus(ctx),
        () => provider.pullAttendance(ctx, null), () => provider.listEmployees(ctx, null), () => provider.upsertEmployee(ctx, sampleEmployee),
        () => provider.deleteEmployee(ctx, sampleEmployee.deviceUserId), () => provider.pullAttendance(ctx, { bogus: 'cursor' }),
      ];
      if (provider.restart) calls.push(() => provider.restart!(ctx));
      for (const call of calls) {
        try { await call(); } catch (e) { assert.ok(ProviderError.is(e), `expected ProviderError, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`); }
      }
    });

    api.it('placeholders throw NOT_IMPLEMENTED everywhere', async () => {
      const { provider, ctx, sampleEmployee = DEFAULT_EMPLOYEE } = await factory();
      if (provider.definition.status !== 'placeholder') return;
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['testConnection', () => provider.testConnection(ctx)], ['getDeviceInfo', () => provider.getDeviceInfo(ctx)], ['getCapabilities', () => provider.getCapabilities(ctx)],
        ['getDeviceStatus', () => provider.getDeviceStatus(ctx)], ['pullAttendance', () => provider.pullAttendance(ctx, null)], ['listEmployees', () => provider.listEmployees(ctx, null)],
        ['upsertEmployee', () => provider.upsertEmployee(ctx, sampleEmployee)], ['deleteEmployee', () => provider.deleteEmployee(ctx, sampleEmployee.deviceUserId)],
      ];
      for (const [what, call] of calls) {
        const err = await expectProviderError(call, what);
        assert.equal(err.code, 'NOT_IMPLEMENTED', `${what} must throw NOT_IMPLEMENTED`);
        assert.equal(err.retryable, false);
      }
    });

    api.it('pullAttendance is idempotent, advances the cursor and reports hasMore honestly', async () => {
      const { provider, ctx, maxPages = 20 } = await factory();
      if (!provider.definition.capabilities.attendancePull || provider.definition.status === 'placeholder') return;
      const first = await provider.pullAttendance(ctx, null);
      const again = await provider.pullAttendance(ctx, null);
      assert.deepEqual(stable(again), stable(first), 'same cursor must yield the same page');
      for (const t of first.transactions) assert.ok(rawTransactionSchema.safeParse(t).success, 'transactions must satisfy rawTransactionSchema');
      if (first.transactions.length > 0) assert.notDeepEqual(first.nextCursor, null, 'cursor must advance after a non-empty page');

      let page = first;
      let pages = 1;
      const seen = new Set<string>();
      const remember = (r: AttendancePullResult): void => { for (const t of r.transactions) if (t.providerTransactionId !== null) seen.add(t.providerTransactionId); };
      remember(first);
      while (page.hasMore && pages < maxPages) {
        const next = await provider.pullAttendance(ctx, page.nextCursor);
        assert.notDeepEqual(next.nextCursor, page.nextCursor, 'hasMore=true must be followed by a cursor that advances');
        for (const t of next.transactions) assert.ok(rawTransactionSchema.safeParse(t).success);
        remember(next);
        page = next;
        pages += 1;
      }
      if (!page.hasMore) {
        // A device may legitimately re-send records it already delivered (idempotent ingestion absorbs them),
        // but it must not invent new ones or move the cursor once it has claimed there is nothing more.
        const tail = await provider.pullAttendance(ctx, page.nextCursor);
        for (const t of tail.transactions) {
          assert.ok(t.providerTransactionId !== null && seen.has(t.providerTransactionId), 'hasMore=false: the next page may only replay already-delivered transactions');
        }
        assert.equal(tail.hasMore, false, 'hasMore must stay false once the stream is exhausted');
        assert.deepEqual(tail.nextCursor, page.nextCursor, 'a page without new data must not move the cursor');
      }
    });

    api.it('upsert / list / delete round trip', async () => {
      const { provider, ctx, sampleEmployee = DEFAULT_EMPLOYEE } = await factory();
      const caps = provider.definition.capabilities;
      if (!(caps.employeePush && caps.employeePull && caps.employeeDelete) || provider.definition.status === 'placeholder') return;
      const up = await provider.upsertEmployee(ctx, sampleEmployee);
      assert.equal(up.ok, true);
      if (up.async) return; // push devices complete asynchronously; nothing to observe synchronously
      const listAll = async (): Promise<DeviceEmployee[]> => {
        const out: DeviceEmployee[] = [];
        let cursor: string | null = null;
        do {
          const page = await provider.listEmployees(ctx, cursor);
          out.push(...page.employees);
          cursor = page.nextCursor;
        } while (cursor !== null && out.length < 100_000);
        return out;
      };
      const afterUpsert = await listAll();
      assert.ok(afterUpsert.some((e) => e.deviceUserId === sampleEmployee.deviceUserId), 'listed after upsert');
      const del = await provider.deleteEmployee(ctx, sampleEmployee.deviceUserId);
      assert.equal(del.ok, true);
      if (del.async) return;
      const afterDelete = await listAll();
      assert.ok(!afterDelete.some((e) => e.deviceUserId === sampleEmployee.deviceUserId), 'absent after delete');
    });
  });
}
