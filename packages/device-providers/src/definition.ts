import { deviceCapabilitiesSchema, providerConfigSchemaSchema, providerThrottlingSchema, type DeviceCapabilities, type ProviderConfigSchema } from '@flowza/contracts';
import { ProviderError, type ProviderDefinition } from './types.js';

/** Input accepted by {@link defineProvider}: capabilities may be partial (missing keys default to false). */
export type ProviderDefinitionInput = Omit<ProviderDefinition, 'capabilities' | 'secretFields'> & {
  capabilities: Partial<DeviceCapabilities>;
};

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/; // mirrors the device_providers.key check constraint

/**
 * Config fields whose values must be stored encrypted in device_credentials and never returned to clients.
 * A field is secret when it is flagged `secret: true` OR typed `password` — a password field that forgot the
 * flag must never end up in the plain `devices.config` column.
 */
export function secretFieldsOf(configSchema: ProviderConfigSchema): string[] {
  return configSchema.fields.filter((f) => f.secret === true || f.type === 'password').map((f) => f.key);
}

/** Builds a validated, fully-populated {@link ProviderDefinition}. Throws INVALID_CONFIG on a bad definition. */
export function defineProvider(input: ProviderDefinitionInput): ProviderDefinition {
  if (!KEY_PATTERN.test(input.key)) throw new ProviderError('INVALID_CONFIG', `Invalid provider key "${input.key}"`);
  const capabilities = deviceCapabilitiesSchema.safeParse(input.capabilities);
  if (!capabilities.success) throw new ProviderError('INVALID_CONFIG', `Invalid capabilities for provider ${input.key}`, { details: { issues: capabilities.error.issues } });
  const configSchema = providerConfigSchemaSchema.safeParse(input.configSchema);
  if (!configSchema.success) throw new ProviderError('INVALID_CONFIG', `Invalid config schema for provider ${input.key}`, { details: { issues: configSchema.error.issues } });
  const throttling = providerThrottlingSchema.safeParse(input.throttling);
  if (!throttling.success) throw new ProviderError('INVALID_CONFIG', `Invalid throttling for provider ${input.key}`, { details: { issues: throttling.error.issues } });
  const keys = new Set<string>();
  for (const field of configSchema.data.fields) {
    if (keys.has(field.key)) throw new ProviderError('INVALID_CONFIG', `Duplicate config field "${field.key}" in provider ${input.key}`);
    keys.add(field.key);
  }
  const definition: ProviderDefinition = {
    ...input,
    capabilities: capabilities.data,
    configSchema: configSchema.data,
    throttling: throttling.data,
    secretFields: secretFieldsOf(configSchema.data),
  };
  return Object.freeze(definition);
}
