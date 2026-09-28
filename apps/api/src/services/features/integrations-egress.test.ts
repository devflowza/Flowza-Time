import { describe, expect, it } from 'vitest';
import { defaultRegistry, FLOWZA_FINANCE_DEFINITION, MOCK_DEFINITION, type EgressLookup } from '@flowza/device-providers';
import { AppError } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { assertEndpointAllowed } from './devices.service.js';
import { validateFinanceBaseUrl } from './integrations.service.js';

/** DNS answers for the egress guard: tests never resolve real names. */
const lookup: EgressLookup = async (hostname) => {
  const table: Record<string, string> = { 'localtest.me': '127.0.0.1', '7f000001.nip.io': '127.0.0.1', 'finance.flowza.ai': '104.18.38.10', 'fdic.gov': '23.41.12.9', 'ucjtxdmklhhhvayirwqe.supabase.co': '104.18.38.10' };
  const address = table[hostname];
  if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  return [{ address, family: 4 }];
};
const deps = { providers: defaultRegistry({ flowzaFinance: { lookup } }), config: { FLOWZA_ALLOW_PRIVATE_EGRESS: false } } as unknown as ApiDeps;

describe('Finance base URL validation on save and test (review D1)', () => {
  it.each([
    'https://localtest.me:41437/functions/v1', 'https://7f000001.nip.io/functions/v1', 'https://flowza-time-api.internal./functions/v1', 'https://intranet./functions/v1', 'https://db.internal./x',
    'https://app.localhost./x', 'https://printer.local./x', 'https://nas.lan./x', 'https://[fec0::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://127.0.0.1/x',
  ])('refuses %s with a 400 before any request is made', async (url) => {
    const err = await validateFinanceBaseUrl(deps, url).catch((e: unknown) => e);
    expect(AppError.is(err)).toBe(true);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400, message: 'Finance base URL must point at a public host' });
  });

  it('accepts public hosts (and strips a trailing dot)', async () => {
    expect(await validateFinanceBaseUrl(deps, 'https://finance.flowza.ai./functions/v1')).toBe('https://finance.flowza.ai/functions/v1');
    expect(await validateFinanceBaseUrl(deps, 'https://fdic.gov/functions/v1/')).toBe('https://fdic.gov/functions/v1');
    expect(await validateFinanceBaseUrl(deps, undefined)).toBe('https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1');
  });
});

describe('generic cloud-provider egress check (review D17)', () => {
  it('refuses private literals and names but no longer refuses public hosts whose name starts with fc / fd / fe80', () => {
    for (const ok of ['https://fdic.gov/x', 'https://fd.example.com/x', 'https://fc2.com/x', 'https://fe80.example.net/x', 'https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1']) {
      expect(() => assertEndpointAllowed(FLOWZA_FINANCE_DEFINITION, ok), ok).not.toThrow();
    }
    for (const bad of ['https://[fd00::1]/x', 'https://[fe80::1]/x', 'https://127.0.0.1/x', 'https://x.internal./x', 'https://localhost./x', 'https://intranet/x', 'https://[::ffff:10.0.0.1]/x']) {
      expect(() => assertEndpointAllowed(FLOWZA_FINANCE_DEFINITION, bad), bad).toThrow(/private or loopback/);
    }
    // on-prem / LAN providers legitimately use private ranges (over a VPN): only cloud integrations are checked
    expect(() => assertEndpointAllowed({ ...MOCK_DEFINITION, integrationType: 'LAN' }, 'http://192.168.1.20/api')).not.toThrow();
  });
});
