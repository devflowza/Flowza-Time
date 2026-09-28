import { createLogger } from '@flowza/shared';
import type { ProviderContext } from './types.js';

/**
 * Test-only entry point: `@flowza/device-providers/testing`. Nothing here is reachable from the production entry
 * (`@flowza/device-providers`), so the API and worker bundles never carry the `node:http` mock Finance server or the test context.
 */
export * from './providers/flowza-finance/mock-finance-server.js';

/**
 * Builds a {@link ProviderContext} for tests and local tooling. The logger is silent; `acquire` is a
 * counting no-op so tests can assert the provider throttles once per outbound request.
 */
export function createTestProviderContext(overrides: Partial<ProviderContext> & { acquireCalls?: { count: number } } = {}): ProviderContext & { acquireCalls: { count: number } } {
  const acquireCalls = overrides.acquireCalls ?? { count: 0 };
  const { acquireCalls: _ignored, ...rest } = overrides;
  return {
    organizationId: '00000000-0000-0000-0000-000000000001',
    deviceId: '00000000-0000-0000-0000-0000000000d1',
    deviceCode: 'DEV-1',
    timezone: 'Asia/Muscat',
    config: {},
    credentials: {},
    endpointUrl: null,
    serialNumber: 'SIM0001',
    logger: createLogger({ name: 'device-providers-test', level: 'silent' }),
    signal: new AbortController().signal,
    acquire: async () => { acquireCalls.count += 1; },
    ...rest,
    acquireCalls,
  };
}
