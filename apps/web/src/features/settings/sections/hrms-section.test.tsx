import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { ApiKeyDto, HrmsBatchListItem, HrmsIntegrationDto } from '@flowza/contracts';
import i18n from '@/lib/i18n';
import { apiMock, grant, grantAll, mockGet, renderWithProviders, resetApiMock } from '@/features/employees/test-utils';
import HrmsSection from './hrms-section';

const ENDPOINT = 'https://api.flowza.test/api/v1/inbound/hrms';
const config: HrmsIntegrationDto = { enabled: false, preset: 'generic', employeeMapping: [], orgUnitMapping: [], statusMapping: [], genderMapping: [], employmentTypeMapping: [], defaultBranchCode: null, endpoint: ENDPOINT };
const key: ApiKeyDto = { id: 'key-1', name: 'Mawred Plus feed', prefix: 'fzk_AbCdEfGh', scopes: ['hrms:write'], status: 'active', lastUsedAt: null, expiresAt: '2027-10-19T08:00:00.000Z', revokedAt: null, createdBy: 'u1', createdByName: 'Dev', createdAt: '2026-10-19T08:00:00.000Z' };
const batch: HrmsBatchListItem = { id: 'b-1', kind: 'EMPLOYEES', status: 'COMPLETED', reference: 'MAWRED-01', apiKeyPrefix: 'fzk_AbCdEfGh', totalRows: 120, validRows: 118, errorRows: 2, importedRows: 118, createdAt: '2026-10-19T07:00:00.000Z' };

function mockAll(overrides: Record<string, unknown> = {}) {
  mockGet({
    '/orgs/org-1/integrations/hrms': { data: config },
    '/orgs/org-1/api-keys': { data: [key] },
    '/orgs/org-1/integrations/hrms/batches': { data: [batch] },
    ...overrides,
  });
}

describe('Settings → HR system (HRMS)', () => {
  beforeEach(async () => { resetApiMock(); grantAll(); await i18n.changeLanguage('en'); });

  it('asks for integration.manage', () => {
    grant('organization.view');
    renderWithProviders(<HrmsSection />);
    expect(screen.getByText(/integration\.manage permission to connect an HR system/)).toBeInTheDocument();
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('switches the feed on with the Mawred Plus preset mapping filled in, and saves the whole configuration', async () => {
    mockAll();
    apiMock.put.mockResolvedValue({ data: { ...config, enabled: true, preset: 'mawred_plus' } });
    renderWithProviders(<HrmsSection />);
    expect(await screen.findByDisplayValue(ENDPOINT)).toBeInTheDocument();
    // empty lists: the preset is used (the generic preset maps nothing)
    expect(screen.getAllByText('Empty: the preset\'s mapping (0 entries) is used.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('Receive batches from the HR system'));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Field mapping preset' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Mawred Plus (starting mapping)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fill in the preset\'s mapping' }));
    // the civil ID row of the preset is now editable
    const civil = screen.getAllByDisplayValue('CivilID')[0]!;
    fireEvent.change(civil, { target: { value: 'CIVIL_NO' } });
    fireEvent.change(screen.getByLabelText('Default branch code'), { target: { value: 'HQ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.put.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/orgs/org-1/integrations/hrms');
    expect(body).toMatchObject({ enabled: true, preset: 'mawred_plus', defaultBranchCode: 'HQ' });
    expect(body['employeeMapping']).toContainEqual({ source: 'CIVIL_NO', target: 'civilId' });
    expect(body['employeeMapping']).toContainEqual({ source: 'EmployeeNo', target: 'employeeNumber' });
    expect(body['statusMapping']).toContainEqual({ source: 'على رأس العمل', target: 'active' });
    expect(body['orgUnitMapping']).toContainEqual({ source: 'ParentUnitCode', target: 'parentCode' });
  });

  it('refuses a source name listed twice before sending anything', async () => {
    mockAll();
    renderWithProviders(<HrmsSection />);
    const fieldset = await screen.findByRole('group', { name: 'Employee fields' });
    const add = within(fieldset).getByRole('button', { name: 'Add' });
    fireEvent.click(add); fireEvent.click(add);
    fireEvent.change(within(fieldset).getByLabelText('HR system name 1'), { target: { value: 'StaffNo' } });
    fireEvent.change(within(fieldset).getByLabelText('HR system name 2'), { target: { value: 'staffno' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('"staffno" appears twice');
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it('creates an API key and shows its secret once; revokes a key after confirmation', async () => {
    mockAll();
    apiMock.post.mockImplementation(async (path: string) => (path.endsWith('/revoke') ? { data: { ...key, status: 'revoked' } } : { data: { ...key, id: 'key-2', name: 'Feed 2', secret: 'fzk_AbCdEfGh_secretsecretsecretsecretsecretsecretxyz' } }));
    renderWithProviders(<HrmsSection />);
    const keys = await screen.findByRole('region', { name: 'API keys' });
    expect((await within(keys).findAllByText('Mawred Plus feed')).length).toBeGreaterThan(0);
    expect(within(keys).getByText('Never')).toBeInTheDocument();

    fireEvent.click(within(keys).getByRole('button', { name: 'Create API key' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Feed 2' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Read batch status' })); // write only
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create API key' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/api-keys', { name: 'Feed 2', scopes: ['hrms:write'], expiresInDays: 365 }));
    const secret = await screen.findByDisplayValue('fzk_AbCdEfGh_secretsecretsecretsecretsecretsecretxyz');
    expect(secret).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'I have stored the key' }));
    await waitFor(() => expect(screen.queryByDisplayValue(/secretsecret/)).not.toBeInTheDocument());

    fireEvent.click(within(keys).getByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('Revoke the key Mawred Plus feed?');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/orgs/org-1/api-keys/key-1/revoke'));
  });

  it('lists the latest batches with their counts', async () => {
    mockAll();
    renderWithProviders(<HrmsSection />);
    const region = await screen.findByRole('region', { name: 'Recent batches' });
    expect(await within(region).findByText('MAWRED-01')).toBeInTheDocument();
    expect(within(region).getByText('Completed')).toBeInTheDocument();
    expect(within(region).getByText('120')).toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    mockAll();
    await i18n.changeLanguage('ar');
    renderWithProviders(<HrmsSection />);
    expect(await screen.findByText('نظام الموارد البشرية (HRMS)')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'مفاتيح API' })).toBeInTheDocument();
    await i18n.changeLanguage('en');
  });
});
