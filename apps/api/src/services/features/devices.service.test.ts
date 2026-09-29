import { describe, expect, it } from 'vitest';
import { defaultRegistry } from '@flowza/device-providers';
import type { ApiDeps } from '../../deps.js';
import { providerAllowedByFlags, pushUrls } from './devices.service.js';

const reg = defaultRegistry();

describe('providerAllowedByFlags', () => {
  it('lets the most specific provider flag win over the vendor-wide one, in any flag order', () => {
    const push = reg.get('hikvision_push').definition;
    const isapi = reg.get('hikvision_isapi').definition;
    for (const flags of [{ provider_hikvision: false, provider_hikvision_push: true }, { provider_hikvision_push: true, provider_hikvision: false }]) {
      expect(providerAllowedByFlags(push, flags)).toBe(true);
      expect(providerAllowedByFlags(isapi, flags)).toBe(false);
    }
    expect(providerAllowedByFlags(push, { provider_hikvision: false })).toBe(false);
    expect(providerAllowedByFlags(push, { provider_hikvision: true, provider_hikvision_push: false })).toBe(false);
    expect(providerAllowedByFlags(reg.get('zkteco_push').definition, { provider_hikvision: false })).toBe(true);
  });
});

describe('pushUrls', () => {
  const deps = { config: { API_PUBLIC_URL: 'https://api.flowza.example/' } } as unknown as ApiDeps;
  it('appends the serial for protocols whose requests carry none (Hikvision HTTP Listening)', () => {
    expect(pushUrls(deps, reg.get('hikvision_push'), 'd1', 'tok', 'DS-K1T341-1').pushUrl).toBe('https://api.flowza.example/device-push/hikvision/~tok/DS-K1T341-1');
    expect(pushUrls(deps, reg.get('zkteco_push'), 'd1', 'tok', 'ZK1').pushUrl).toBe('https://api.flowza.example/device-push/iclock/~tok');
    expect(pushUrls(deps, reg.get('hikvision_push'), 'd1', null, 'X').pushUrl).toBeNull();
  });
});
