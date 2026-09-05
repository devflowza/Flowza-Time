import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderConfigField } from '@flowza/contracts';
import '@/lib/i18n';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import { ProviderConfigForm } from './provider-config-form';
import { normalizeProviderConfig, validateProviderConfig, type ConfigValues } from './provider-config';

registerNamespace('devices', en, ar);

const FIELDS: ProviderConfigField[] = [
  { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, secret: false },
  { key: 'apiKey', label: 'API key', type: 'password', required: true, secret: true },
  { key: 'port', label: 'Port', type: 'number', required: false, secret: false, default: 4370 },
  { key: 'protocol', label: 'Protocol', type: 'select', required: false, secret: false, options: ['tcp', 'udp'], default: 'tcp' },
  { key: 'useTls', label: 'Use TLS', type: 'boolean', required: false, secret: false },
];

function Harness({ initial = {}, masked }: { initial?: ConfigValues; masked?: Record<string, unknown> }) {
  const [values, setValues] = useState<ConfigValues>(initial);
  const errors = validateProviderConfig(FIELDS, values);
  return <><ProviderConfigForm fields={FIELDS} values={values} onChange={setValues} errors={errors} masked={masked} /><output data-testid="out">{JSON.stringify(normalizeProviderConfig(FIELDS, values))}</output></>;
}

describe('ProviderConfigForm', () => {
  it('renders secret fields as password inputs and never echoes stored values', () => {
    render(<Harness masked={{ apiKey: '****abcd' }} />);
    const key = screen.getByLabelText(/API key/) as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(key.placeholder).toBe('****abcd');
    expect((screen.getByLabelText(/Base URL/) as HTMLInputElement).type).toBe('url');
    expect((screen.getByLabelText(/Port/) as HTMLInputElement).type).toBe('number');
    expect(screen.getByRole('switch', { name: /Use TLS/ })).toBeInTheDocument();
  });

  it('flags required and malformed values like the API does', () => {
    const errors = validateProviderConfig(FIELDS, { baseUrl: 'ftp://x', port: 'abc' });
    expect(errors).toEqual({ baseUrl: 'url', apiKey: 'required', port: 'number' });
    expect(validateProviderConfig(FIELDS, { baseUrl: 'https://cloud.example.com', apiKey: 'k' })).toEqual({});
  });

  it('shows translated errors and normalises numbers on change', () => {
    render(<Harness />);
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('This field is required');
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: 'https://device.example.com' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'secret-1' } });
    fireEvent.change(screen.getByLabelText(/Port/), { target: { value: '8080' } });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(JSON.parse(screen.getByTestId('out').textContent ?? '{}')).toEqual({ baseUrl: 'https://device.example.com', apiKey: 'secret-1', port: 8080 });
  });

  it('can render only the secret subset for credential re-entry', () => {
    render(<ProviderConfigForm fields={FIELDS} values={{}} onChange={() => undefined} only="secret" />);
    expect(screen.getByLabelText(/API key/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Base URL/)).not.toBeInTheDocument();
  });
});
