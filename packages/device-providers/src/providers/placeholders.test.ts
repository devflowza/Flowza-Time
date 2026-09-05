import { describe, expect, it } from 'vitest';
import { describeProviderConformance } from '../conformance.js';
import { createTestProviderContext } from '../testing.js';
import { ProviderError } from '../types.js';
import { createPlaceholderProviders, EsslPushProvider, FingerTecPushProvider, ZKBioTimeProvider } from './placeholders.js';
import { ICLOCK_PROTOCOL_KEY } from './zkteco/push-protocol.js';

const employee = { deviceUserId: '1', name: 'X', cardNumber: null, pin: null, privilege: 'user' as const, enabled: true, photoUrl: null, extra: {} };
const TAB = '\t';

describe('placeholder providers', () => {
  const providers = createPlaceholderProviders();
  it('cover the remaining reference keys with placeholder status', () => {
    expect(providers.map((p) => p.definition.key)).toEqual(['zkteco_biotime', 'hikvision_isapi', 'hikvision_hpp', 'suprema_biostar2', 'anviz_crosschex_cloud', 'essl_push', 'fingertec_push', 'matrix_cosec', 'nitgen']);
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
      const restart = p.restart?.bind(p);
      if (restart) ops.push(() => restart(ctx));
      for (const op of ops) {
        const err = await op().catch((e: unknown) => e);
        expect(ProviderError.is(err)).toBe(true);
        expect((err as ProviderError).code).toBe('NOT_IMPLEMENTED');
        expect((err as ProviderError).retryable).toBe(false);
        expect((err as ProviderError).message).toBe(`Provider ${p.definition.name} requires vendor credentials/hardware verification — see docs/device-integrations.md`);
      }
    });
  }
  it('ZKTeco-derived brands expose the shared iclock handler but stay placeholders', () => {
    const essl = new EsslPushProvider();
    const ft = new FingerTecPushProvider();
    expect(essl.pushProtocol.protocolKey).toBe(ICLOCK_PROTOCOL_KEY);
    expect(ft.pushProtocol.protocolKey).toBe(ICLOCK_PROTOCOL_KEY);
    expect(essl.mode).toBe('placeholder');
    expect(essl.definition).toMatchObject({ key: 'essl_push', status: 'placeholder', verificationStatus: 'UNVERIFIED', integrationType: 'DEVICE_PUSH' });
    expect(ft.definition).toMatchObject({ key: 'fingertec_push', status: 'placeholder', verificationStatus: 'UNVERIFIED' });
    // Inbound parsing still works: that is real data from a real device, not a faked success.
    const r = essl.pushProtocol.parseInbound(
      { method: 'POST', path: '/iclock/cdata', query: { SN: 'E1', table: 'ATTLOG' }, headers: {}, rawBody: `5${TAB}2026-03-10 08:00:00${TAB}0${TAB}1` },
      { timezone: 'Asia/Muscat', serialNumber: 'E1' },
    );
    expect(r.transactions[0]).toMatchObject({ deviceEmployeeId: '5', punchedAt: '2026-03-10T04:00:00Z' });
  });
});

describeProviderConformance('zkteco_biotime (placeholder)', () => ({ provider: new ZKBioTimeProvider(), ctx: createTestProviderContext() }), { describe, it });
describeProviderConformance('essl_push (placeholder, iclock-derived)', () => ({ provider: new EsslPushProvider(), ctx: createTestProviderContext() }), { describe, it });
