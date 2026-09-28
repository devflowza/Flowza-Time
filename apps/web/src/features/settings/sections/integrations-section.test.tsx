import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import { CONNECTION_STATUSES, SYNC_STATUSES, type FinanceIntegrationDto, type FinanceIntegrationStatusDto } from '@flowza/contracts';
import i18n from '@/lib/i18n';
import { registerNamespace } from '@/lib/i18n-namespace';
import { todayIso } from '@/lib/format';
import enSync from '@/locales/en/sync.json';
import arSync from '@/locales/ar/sync.json';
import enDevices from '@/locales/en/devices.json';
import arDevices from '@/locales/ar/devices.json';
import enSettings from '@/locales/en/settings.json';
import arSettings from '@/locales/ar/settings.json';
import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import IntegrationsSection from './integrations-section';

registerNamespace('sync', enSync, arSync);
registerNamespace('devices', enDevices, arDevices);

const BASE = 'https://ucjtxdmklhhhvayirwqe.supabase.co/functions/v1';
const unconfigured: FinanceIntegrationDto = { configured: false, enabled: false, deviceId: null, branchId: null, baseUrl: BASE, deviceSerial: null, direction: 'both', pinKey: 'employee_number', pollMinutes: 10, syncFrom: '2026-08-28', hasToken: false, tokenMasked: null, connectionStatus: null, lastErrorCode: null, lastError: null, updatedAt: null };
const configured: FinanceIntegrationDto = { ...unconfigured, configured: true, enabled: true, deviceId: 'dev-fin', branchId: 'br-1', deviceSerial: 'FLOWZA-TIME-ACME', hasToken: true, tokenMasked: '****cdef', connectionStatus: 'online', updatedAt: '2026-09-27T08:00:00.000Z' };
const status: FinanceIntegrationStatusDto = {
  configured: true, enabled: true, deviceId: 'dev-fin', connectionStatus: 'online',
  state: { lastPushedEventId: null, lastPushedEventAt: null, pushPositionAt: '2026-09-27T07:54:55.000Z', pushRetryAttempts: 0, lastPushAt: '2026-09-27T07:55:00.000Z', lastPushCount: 12, nextPushAt: null, lastPullAt: '2026-09-27T07:50:00.000Z', lastPullCount: 4, lastError: 'VENDOR_ERROR: Flowza Finance attendance-ingest failed (HTTP 503)', lastErrorAt: '2026-09-27T07:40:00.000Z', consecutiveFailures: 2, updatedAt: '2026-09-27T07:55:00.000Z' },
  cursor: { lastPulledAt: '2026-09-27T07:50:00.000Z', lastTransactionAt: '2026-09-27T07:30:00.000Z' }, circuit: null, unmatchedCount: 3, pendingCount: 0,
  lastJobs: [{ id: 'job-1', jobType: 'PUSH_ATTENDANCE', trigger: 'SCHEDULED', status: 'SUCCESS', createdAt: '2026-09-27T07:55:00.000Z', finishedAt: '2026-09-27T07:55:02.000Z', recordsIngested: 12, errorCode: null, error: null, itemResult: null }],
};

describe('IntegrationsSection (Flowza Finance)', () => {
  beforeEach(() => { resetApiMock(); grantAll(); });

  it('creates the connector: serial + token are required, defaults are sent, and there is no status card before it exists', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: unconfigured } });
    apiMock.put.mockResolvedValue({ data: { ...configured } });
    renderWithProviders(<IntegrationsSection />);
    const serial = await screen.findByLabelText(/Finance device serial/);
    expect(screen.getByLabelText(/Finance functions base URL/)).toHaveValue(BASE);
    expect(screen.queryByText('Sync status')).not.toBeInTheDocument();

    fireEvent.change(serial, { target: { value: 'bad serial!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Letters, digits/);
    expect(apiMock.put).not.toHaveBeenCalled();

    fireEvent.change(serial, { target: { value: 'FLOWZA-TIME-ACME' } });
    fireEvent.change(screen.getByLabelText(/Finance push token/), { target: { value: 'push-token-0123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put).toHaveBeenCalledWith('/orgs/org-1/integrations/finance', { enabled: true, baseUrl: BASE, deviceSerial: 'FLOWZA-TIME-ACME', token: 'push-token-0123456789', direction: 'both', pinKey: 'employee_number', pollMinutes: 10, syncFrom: '2026-08-28' });
  });

  it('keeps the stored token (masked, never shown) unless replaced, and validates the poll interval', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.put.mockResolvedValue({ data: { ...configured, pollMinutes: 15 } });
    renderWithProviders(<IntegrationsSection />);
    expect(await screen.findByText('Stored token ****cdef')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Finance push token/)).not.toBeInTheDocument();
    const poll = screen.getByLabelText(/Sync every/);
    fireEvent.change(poll, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/>=5/);
    expect(apiMock.put).not.toHaveBeenCalled();
    fireEvent.change(poll, { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    const body = apiMock.put.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).toMatchObject({ deviceSerial: 'FLOWZA-TIME-ACME', pollMinutes: 15 });
    expect(body).not.toHaveProperty('token');
  });

  it('replaces the token only through the replace flow', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.put.mockResolvedValue({ data: configured });
    renderWithProviders(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    const token = screen.getByLabelText(/Finance push token/);
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveValue('');
    fireEvent.change(token, { target: { value: 'new-token-0123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put.mock.calls[0]![1]).toMatchObject({ token: 'new-token-0123456789' });
  });

  it('switches the direction with the select', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.put.mockResolvedValue({ data: { ...configured, direction: 'push' } });
    renderWithProviders(<IntegrationsSection />);
    fireEvent.keyDown(await screen.findByRole('combobox', { name: 'Direction' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /Push only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put.mock.calls[0]![1]).toMatchObject({ direction: 'push' });
  });

  it('tests the connection with the stored token and shows Finance time and the first punch', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.post.mockResolvedValue({ data: { ok: true, message: 'Connected to Flowza Finance as FLOWZA-TIME-ACME', latencyMs: 87, code: null, retryable: false, serverTime: '2026-09-27T08:01:00.000Z', firstPunchAt: '2026-03-01T04:00:00.000Z', usedStoredCredentials: true } });
    renderWithProviders(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/integrations/finance/test', { baseUrl: BASE, deviceSerial: 'FLOWZA-TIME-ACME' }));
    const result = (await screen.findByText('Connected to Flowza Finance')).closest('[role="status"]') as HTMLElement;
    expect(result).not.toBeNull();
    expect(within(result).getByText('Used the stored token')).toBeInTheDocument();
    expect(within(result).getByText(/First punch 01 Mar 2026/)).toBeInTheDocument();
  });

  it('shows a failed test with its code, translated (the raw code only as a tooltip for support)', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.post.mockResolvedValue({ data: { ok: false, message: 'Flowza Finance rejected the device credential', latencyMs: 40, code: 'AUTH_FAILED', retryable: false, serverTime: null, firstPunchAt: null, usedStoredCredentials: true } });
    renderWithProviders(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    const result = (await screen.findByText('Connection failed')).closest('[role="status"]') as HTMLElement;
    expect(result).not.toBeNull();
    expect(within(result).getByText('Credential rejected')).toHaveAttribute('title', 'AUTH_FAILED');
    expect(result).not.toHaveTextContent('AUTH_FAILED');
  });

  it('shows the sync status, links unmatched punches to triage and queues a sync', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.post.mockResolvedValue({ data: { pullJobId: 'job-pull', pushJobId: 'job-push', message: 'Queued Flowza Finance pull and push.' } });
    renderWithProviders(<IntegrationsSection />);
    expect(await screen.findByText('Sync status')).toBeInTheDocument();
    expect(await screen.findByText('4 punches')).toBeInTheDocument();
    expect(screen.getAllByText('12 punches').length).toBeGreaterThan(0);
    expect(screen.getByText('Push attendance')).toBeInTheDocument();
    expect(screen.getAllByText(/HTTP 503/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Sync now/ }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/integrations/finance/sync-now', {}));
    fireEvent.click(screen.getByText('Unmatched punches'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/attendance?tab=raw&processingStatus=unmatched&deviceId=dev-fin'));
  });

  it('start date: shows the stored day, never offers a day after today, refuses a future one and sends a changed one', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.put.mockResolvedValue({ data: { ...configured, syncFrom: '2026-07-01' } });
    renderWithProviders(<IntegrationsSection />);
    const from = await screen.findByLabelText(/Synchronise from/);
    expect(from).toHaveValue('2026-08-28');
    expect(from).toHaveAttribute('type', 'date');
    expect(from).toHaveAttribute('max', todayIso('Asia/Muscat'));
    fireEvent.change(from, { target: { value: '2999-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/cannot be in the future/);
    expect(apiMock.put).not.toHaveBeenCalled();
    fireEvent.change(from, { target: { value: '2026-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    expect(apiMock.put.mock.calls[0]![1]).toMatchObject({ syncFrom: '2026-07-01' });
  });

  it('disconnects only after confirmation, through DELETE', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: status } });
    apiMock.delete.mockResolvedValue({ data: { ...configured, enabled: false, hasToken: false, tokenMasked: null } });
    renderWithProviders(<IntegrationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disconnect Flowza Finance?')).toBeInTheDocument();
    expect(within(dialog).getByText(/token is deleted/)).toBeInTheDocument();
    expect(apiMock.delete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(apiMock.delete).toHaveBeenCalledWith('/orgs/org-1/integrations/finance'));
  });

  it('offers no Disconnect for a connector that is already disconnected (disabled, no token)', async () => {
    mockGet({ '/orgs/org-1/integrations/finance': { data: { ...configured, enabled: false, hasToken: false, tokenMasked: null } }, '/orgs/org-1/integrations/finance/status': { data: { ...status, enabled: false } } });
    renderWithProviders(<IntegrationsSection />);
    expect(await screen.findByText('Sync status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('D14: in Arabic every status value on the card is translated — no raw enum text anywhere on it', async () => {
    const failing: FinanceIntegrationStatusDto = {
      ...status, connectionStatus: 'vendor_degraded', circuit: { state: 'half_open', halfOpenAt: '2026-09-27T08:10:00.000Z', failureCount: 5 },
      state: { ...status.state!, pushRetryAttempts: 2, lastError: 'VENDOR_ERROR: Flowza Finance attendance-ingest failed (HTTP 503)' },
      lastJobs: [
        { ...status.lastJobs[0]!, id: 'job-2', jobType: 'PULL_ATTENDANCE', status: 'FAILED', errorCode: 'VENDOR_ERROR', error: 'Flowza Finance attendance-export is unreachable' },
        { ...status.lastJobs[0]!, id: 'job-3', status: 'PARTIAL_SUCCESS' },
        { ...status.lastJobs[0]!, id: 'job-4', status: 'RETRYING', errorCode: 'RATE_LIMITED' },
        { ...status.lastJobs[0]!, id: 'job-5', status: 'QUEUED' },
      ],
    };
    mockGet({ '/orgs/org-1/integrations/finance': { data: configured }, '/orgs/org-1/integrations/finance/status': { data: failing } });
    await i18n.changeLanguage('ar');
    try {
      renderWithProviders(<IntegrationsSection />);
      const card = await screen.findByRole('region', { name: 'حالة المزامنة' });
      await within(card).findByText('نجاح جزئي');
      for (const text of ['تدهور من المورّد', 'فشل', 'إعادة المحاولة', 'في الطابور', 'سحب الحضور', 'إرسال الحضور', 'اختبار التعافي']) {
        expect(card, text).toHaveTextContent(text);
      }
      expect(within(card).getAllByText('خطأ من Finance').length).toBeGreaterThan(0);
      expect(within(card).getByText('تجاوز حد الطلبات')).toHaveAttribute('title', 'RATE_LIMITED');
      // no enum value in its raw form: connection, job status, job type, circuit state or error code
      expect(card.textContent).not.toMatch(/\b(unknown|online|offline|degraded|vendor_degraded|error|closed|open|half_open|PENDING|QUEUED|RUNNING|SUCCESS|PARTIAL_SUCCESS|FAILED|RETRYING|CANCELLED|PULL_ATTENDANCE|PUSH_ATTENDANCE|VENDOR_ERROR|RATE_LIMITED|AUTH_FAILED|TIMEOUT|INVALID_CONFIG|PROTOCOL_ERROR)\b/);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('D14: every status the card can show has an English and an Arabic label', () => {
    const keys = (o: unknown, prefix = ''): string[] => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)]);
    const unplural = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '');
    expect(new Set(keys(arSettings.integrations).map(unplural))).toEqual(new Set(keys(enSettings.integrations).map(unplural)));
    for (const bundle of [enSettings, arSettings]) {
      for (const state of ['closed', 'open', 'half_open']) expect(bundle.integrations.circuitStates).toHaveProperty(state);
      for (const code of ['AUTH_FAILED', 'DEVICE_OFFLINE', 'RATE_LIMITED', 'TIMEOUT', 'UNSUPPORTED', 'NOT_FOUND', 'INVALID_CONFIG', 'VENDOR_ERROR', 'NOT_IMPLEMENTED', 'PROTOCOL_ERROR', 'CONFLICT', 'INTERNAL', 'CONNECTION_FAILED', 'PROVIDER_ERROR', 'unknown']) {
        expect(bundle.integrations.errorCodes).toHaveProperty(code);
      }
    }
    for (const bundle of [enDevices, arDevices]) for (const c of CONNECTION_STATUSES) expect(bundle.connection).toHaveProperty(c);
    for (const bundle of [enSync, arSync]) {
      for (const st of SYNC_STATUSES) expect(bundle.status).toHaveProperty(st);
      for (const type of ['PULL_ATTENDANCE', 'PUSH_ATTENDANCE']) expect(bundle.jobType).toHaveProperty(type);
    }
  });

  it('asks for integration.manage and loads nothing without it', async () => {
    grant('organization.view');
    renderWithProviders(<IntegrationsSection />);
    expect(await screen.findByText(/integration.manage permission/)).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
