import type { DeviceCapabilities, IntegrationType, ProviderConfigSchema, ProviderStatus, ProviderThrottling, VerificationStatus } from '@flowza/contracts';
import { secretFieldsOf } from './definition.js';
import { createPlaceholderProviders } from './providers/placeholders.js';
import { createMockProvider, type MockProviderOptions } from './providers/mock/mock-provider.js';
import { FlowzaFinanceProvider, type FlowzaFinanceProviderOptions } from './providers/flowza-finance/provider.js';
import { ZKTecoPushProvider } from './providers/zkteco/provider.js';
import { HikvisionPushProvider } from './providers/hikvision/provider.js';
import { createZkPushProtocol } from './providers/zkteco/push-protocol.js';
import { EsslPushProvider, FingerTecPushProvider } from './providers/zkteco/derived.js';
import { ZKBioTimeProvider } from './providers/zkteco-biotime/provider.js';
import { HikvisionIsapiProvider } from './providers/hikvision-isapi/provider.js';
import { SupremaBioStar2Provider } from './providers/suprema-biostar2/provider.js';
import { AnvizCrossChexCloudProvider } from './providers/anviz-crosschex/provider.js';
import { MatrixCosecProvider } from './providers/matrix-cosec/provider.js';
import type { VendorHttpOptions } from './vendor-http.js';
import { ProviderError, type DeviceProvider, type DevicePushProtocolHandler, type ProviderDefinition, type ProviderRegistry } from './types.js';

export { secretFieldsOf };

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** Immutable lookup of providers by key and push-protocol handlers by protocol key. */
export function createProviderRegistry(providers: DeviceProvider[]): ProviderRegistry {
  const byKey = new Map<string, DeviceProvider>();
  const protocols = new Map<string, DevicePushProtocolHandler>();
  for (const p of providers) {
    const key = p.definition.key;
    if (!KEY_PATTERN.test(key)) throw new ProviderError('INVALID_CONFIG', `Invalid provider key "${key}"`);
    if (byKey.has(key)) throw new ProviderError('CONFLICT', `Provider "${key}" registered twice`);
    byKey.set(key, p);
    if (p.pushProtocol) {
      const existing = protocols.get(p.pushProtocol.protocolKey);
      if (existing && existing !== p.pushProtocol) throw new ProviderError('CONFLICT', `Two different handlers claim push protocol "${p.pushProtocol.protocolKey}"`);
      if (!existing) protocols.set(p.pushProtocol.protocolKey, p.pushProtocol);
    }
  }
  return {
    get(key) {
      const p = byKey.get(key);
      if (!p) throw new ProviderError('NOT_FOUND', `Unknown device provider "${key}"`, { retryable: false, details: { key } });
      return p;
    },
    tryGet: (key) => byKey.get(key),
    list: () => [...byKey.values()].map((p) => p.definition),
    pushProtocols: () => [...protocols.values()],
    pushProtocol: (protocolKey) => protocols.get(protocolKey),
  };
}

export interface DefaultRegistryOptions {
  mock?: MockProviderOptions;
  clock?: () => Date;
  /** Flowza Finance connector transport options (tests point it at a local mock server with `allowPrivateHosts`). */
  flowzaFinance?: FlowzaFinanceProviderOptions;
  /** Transport options of the server/device API adapters (BioTime, BioStar 2, ISAPI, CrossChex, COSEC); `allowPrivateHosts` = FLOWZA_ALLOW_PRIVATE_EGRESS. */
  vendorHttp?: VendorHttpOptions;
}

/**
 * Every provider FlowZa ships: the simulator, the Flowza Finance connector, the push handlers (ZKTeco and its eSSL/FingerTec
 * derivatives, Hikvision), the server/device API adapters (all beta, docs/device-integrations.md §4) and the two honest placeholders.
 */
export function defaultProviders(options: DefaultRegistryOptions = {}): DeviceProvider[] {
  const clock = options.clock;
  const iclock = createZkPushProtocol(); // one handler shared by every ZKTeco-derived provider
  const http = { ...(options.vendorHttp ?? {}), ...(clock ? { clock } : {}) };
  return [
    createMockProvider({ ...(clock ? { clock } : {}), ...(options.mock ?? {}) }),
    new FlowzaFinanceProvider({ ...(clock ? { clock } : {}), ...(options.flowzaFinance ?? {}) }),
    new ZKTecoPushProvider({ protocol: iclock, ...(clock ? { clock } : {}) }),
    new HikvisionPushProvider({ ...(clock ? { clock } : {}) }),
    new ZKBioTimeProvider(http),
    new HikvisionIsapiProvider(http),
    new SupremaBioStar2Provider(http),
    new AnvizCrossChexCloudProvider(http),
    new EsslPushProvider({ protocol: iclock, ...(clock ? { clock } : {}) }),
    new FingerTecPushProvider({ protocol: iclock, ...(clock ? { clock } : {}) }),
    new MatrixCosecProvider(http),
    ...createPlaceholderProviders(),
  ];
}
export const defaultRegistry = (options: DefaultRegistryOptions = {}): ProviderRegistry => createProviderRegistry(defaultProviders(options));

/** `sort_order` used by the reference-data migration; unknown keys get 100. */
export const PROVIDER_SORT_ORDER: Readonly<Record<string, number>> = {
  mock: 1, flowza_finance: 5, zkteco_push: 10, zkteco_biotime: 11, hikvision_push: 19, hikvision_isapi: 20, hikvision_hpp: 21, suprema_biostar2: 30,
  anviz_crosschex_cloud: 40, essl_push: 50, fingertec_push: 60, matrix_cosec: 70, nitgen: 80,
};

/** One row of public.device_providers (snake_case = column names) so a sync command can upsert from code. */
export interface DeviceProviderRow {
  key: string;
  vendor: string;
  name: string;
  description: string | null;
  integration_type: IntegrationType;
  status: ProviderStatus;
  capabilities: DeviceCapabilities;
  config_schema: ProviderConfigSchema;
  throttling: ProviderThrottling;
  verification_status: VerificationStatus;
  docs_url: string | null;
  sort_order: number;
}

export function definitionToRow(def: ProviderDefinition, opts: { sortOrder?: number } = {}): DeviceProviderRow {
  return {
    key: def.key,
    vendor: def.vendor,
    name: def.name,
    description: def.description.length > 0 ? def.description : null,
    integration_type: def.integrationType,
    status: def.status,
    capabilities: { ...def.capabilities },
    config_schema: { fields: def.configSchema.fields.map((f) => ({ ...f, ...(f.options ? { options: [...f.options] } : {}) })) },
    throttling: { ...def.throttling },
    verification_status: def.verificationStatus,
    docs_url: def.docsUrl ?? null,
    sort_order: opts.sortOrder ?? PROVIDER_SORT_ORDER[def.key] ?? 100,
  };
}
