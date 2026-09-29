import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { renderWithProviders } from '@/features/employees/test-utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import { hikvisionListeningFields } from './hikvision-listening';
import { PushCredentialsDialog } from './push-credentials-dialog';

registerNamespace('devices', en, ar);

const HIK_URL = 'https://api.flowza.example/device-push/hikvision/~tok_0123456789abcdef/DS-K1T341AMF-1';

describe('hikvisionListeningFields', () => {
  it('splits a Hikvision push URL into the HTTP Listening fields', () => {
    expect(hikvisionListeningFields(HIK_URL)).toEqual({ protocol: 'HTTPS', host: 'api.flowza.example', port: '443', path: '/device-push/hikvision/~tok_0123456789abcdef/DS-K1T341AMF-1' });
    expect(hikvisionListeningFields('http://10.0.0.2:8080/device-push/hikvision/~t/SN')).toMatchObject({ protocol: 'HTTP', port: '8080' });
    expect(hikvisionListeningFields('https://api.flowza.example/device-push/iclock/~tok')).toBeNull();
    expect(hikvisionListeningFields(null)).toBeNull();
    expect(hikvisionListeningFields('not a url')).toBeNull();
  });
});

describe('PushCredentialsDialog', () => {
  it('shows the Hikvision device settings only for a Hikvision push URL', () => {
    const { unmount } = renderWithProviders(<PushCredentialsDialog credentials={{ pushToken: 'tok_0123456789abcdef', pushUrl: HIK_URL, webhookUrl: null }} onClose={() => {}} />);
    expect(screen.getByText(en.push.hikvision.title)).toBeInTheDocument();
    expect(screen.getByText('api.flowza.example')).toBeInTheDocument();
    expect(screen.getByText('/device-push/hikvision/~tok_0123456789abcdef/DS-K1T341AMF-1')).toBeInTheDocument();
    unmount();
    renderWithProviders(<PushCredentialsDialog credentials={{ pushToken: 't', pushUrl: 'https://api.flowza.example/device-push/iclock/~t', webhookUrl: null }} onClose={() => {}} />);
    expect(screen.queryByText(en.push.hikvision.title)).not.toBeInTheDocument();
    expect(screen.getByText(en.push.instructions)).toBeInTheDocument();
  });
});
