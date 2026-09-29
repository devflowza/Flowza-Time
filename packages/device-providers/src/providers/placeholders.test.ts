import { describe, expect, it } from 'vitest';
import { describeProviderConformance } from '../conformance.js';
import { createTestProviderContext } from '../testing.js';
import { ProviderError } from '../types.js';
import { createPlaceholderProviders, NitgenProvider } from './placeholders.js';
import { EsslPushProvider, FingerTecPushProvider } from './zkteco/derived.js';
import { ICLOCK_PROTOCOL_KEY } from './zkteco/push-protocol.js';

const employee = { deviceUserId: '1', name: 'X', cardNumber: null, pin: null, privilege: 'user' as const, enabled: true, photoUrl: null, extra: {} };
const TAB = '\t';

describe('placeholder providers', () => {
  const providers = createPlaceholderProviders();
  it('only the integrations without a public API remain placeholders', () => {
    expect(providers.map((p) => p.definition.key)).toEqual(['hikvision_hpp', 'nitgen']);
    for (const p of providers) {
      expect(p.definition.status).toBe('placeholder');
      expect(p.definition.verificationStatus).not.toBe('VERIFIED');
    }
  });
  for (const p of providers) {
    it(`${p.definition.key}: every operation throws NOT_IMPLEMENTED with the documented message`, async () => {
      const ctx = createTestProviderContext();
      const ops: Array<() => Promise<unknown>> = [
        () => p.testConnection(ctx), () => p.getDeviceInfo(ctx), () => p.getCapabilities(ctx), () => p.getDeviceStatus(ctx),
        () => p.pullAttendance(ctx, null), () => p.listEmployees(ctx, null), () => p.upsertEmployee(ctx, employee), () => p.deleteEmployee(ctx, '1'),
      ];
      for (const op of ops) {
        const err = await op().catch((e: unknown) => e);
        expect(ProviderError.is(err)).toBe(true);
        expect((err as ProviderError).code).toBe('NOT_IMPLEMENTED');
        expect((err as ProviderError).retryable).toBe(false);
        expect((err as ProviderError).message).toBe(`Provider ${p.definition.name} requires vendor credentials/hardware verification — see docs/device-integrations.md`);
      }
    });
  }
});

describe('ZKTeco-derived push brands (eSSL, FingerTec)', () => {
  const lastSeenAt = '2026-03-10T07:59:30Z';
  const clock = () => new Date('2026-03-10T08:00:00Z');
  it('share the iclock handler and run in beta mode', () => {
    const essl = new EsslPushProvider();
    const ft = new FingerTecPushProvider();
    expect(essl.pushProtocol.protocolKey).toBe(ICLOCK_PROTOCOL_KEY);
    expect(ft.pushProtocol.protocolKey).toBe(ICLOCK_PROTOCOL_KEY);
    expect(essl.mode).toBe('beta');
    expect(ft.mode).toBe('beta');
    expect(essl.definition).toMatchObject({ key: 'essl_push', status: 'beta', verificationStatus: 'REPORTED', integrationType: 'DEVICE_PUSH' });
    expect(ft.definition).toMatchObject({ key: 'fingertec_push', status: 'beta', verificationStatus: 'UNVERIFIED', integrationType: 'DEVICE_PUSH' });
  });
  it('parse ATTLOG uploads and queue employee commands like zkteco_push', async () => {
    const essl = new EsslPushProvider({ clock });
    const r = essl.pushProtocol.parseInbound(
      { method: 'POST', path: '/iclock/cdata', query: { SN: 'E1', table: 'ATTLOG' }, headers: {}, rawBody: `5${TAB}2026-03-10 08:00:00${TAB}0${TAB}1` },
      { timezone: 'Asia/Muscat', serialNumber: 'E1' },
    );
    expect(r.transactions[0]).toMatchObject({ deviceEmployeeId: '5', punchedAt: '2026-03-10T04:00:00Z' });
    const ctx = createTestProviderContext({ config: { lastSeenAt } });
    expect(await essl.testConnection(ctx)).toMatchObject({ ok: true });
    const up = await essl.upsertEmployee(ctx, employee);
    expect(up).toMatchObject({ ok: true, async: true });
    expect((up.details?.['commands'] as unknown[]).length).toBeGreaterThan(0);
    expect(await new FingerTecPushProvider({ clock }).restart(ctx)).toMatchObject({ ok: true, async: true });
  });
  it('report "not verified" until the device has contacted FlowZa', async () => {
    expect(await new FingerTecPushProvider({ clock }).testConnection(createTestProviderContext())).toMatchObject({ ok: false });
  });
});

describeProviderConformance('nitgen (placeholder)', () => ({ provider: new NitgenProvider(), ctx: createTestProviderContext() }), { describe, it });
describeProviderConformance('essl_push (beta, iclock-derived)', () => ({ provider: new EsslPushProvider(), ctx: createTestProviderContext(), sampleEmployee: employee }), { describe, it });
describeProviderConformance('fingertec_push (beta, iclock-derived)', () => ({ provider: new FingerTecPushProvider(), ctx: createTestProviderContext(), sampleEmployee: employee }), { describe, it });
