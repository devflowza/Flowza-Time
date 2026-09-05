import type { ProviderConfigField } from '@flowza/contracts';

export type ConfigValue = string | number | boolean;
export type ConfigValues = Record<string, ConfigValue>;

/** Client-side mirror of the API's provider config checks (required / number / url / select); the server re-validates. */
export function validateProviderConfig(fields: ProviderConfigField[], values: ConfigValues, opts: { requireRequired?: boolean } = {}): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    const empty = v === undefined || v === '';
    if (empty) { if (f.required && f.default === undefined && opts.requireRequired !== false) errors[f.key] = 'required'; continue; }
    if (f.type === 'number' && !(typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)))) errors[f.key] = 'number';
    if (f.type === 'url' && typeof v === 'string' && !/^https?:\/\/\S+$/i.test(v)) errors[f.key] = 'url';
    if (f.type === 'select' && f.options && !f.options.includes(String(v))) errors[f.key] = 'select';
    if (f.type === 'boolean' && typeof v !== 'boolean') errors[f.key] = 'boolean';
  }
  return errors;
}

/** Values to submit: typed (numbers as numbers), empty strings dropped, defaults left to the server. */
export function normalizeProviderConfig(fields: ProviderConfigField[], values: ConfigValues): ConfigValues {
  const out: ConfigValues = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === '') continue;
    out[f.key] = f.type === 'number' ? Number(v) : v;
  }
  return out;
}

/** True when a field holds a secret (stored via DeviceCredentialsStore, never echoed back). */
export const isSecretField = (f: ProviderConfigField): boolean => f.secret || f.type === 'password';
