import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', async () => (await import('@/features/employees/test-mocks')).apiClientModule);
vi.mock('@/features/me/use-me', async () => (await import('@/features/employees/test-mocks')).useMeModule);
vi.mock('@/lib/supabase', async () => (await import('@/features/employees/test-mocks')).supabaseModule);
vi.mock('@/lib/env', async () => (await import('@/features/employees/test-mocks')).envModule);

import type { ImportJobDto } from '@flowza/contracts';
import { apiMock, grant, mockGet, renderWithProviders, resetApiMock } from '../test-utils';
import EmployeeImportPage from './employee-import-page';

/** Import page (HRMS workstream): .xlsx accepted, and an import-kind switch for organisational units (department.manage). */
const limit = { used: 2, limit: null, remaining: null, reached: false, source: null };
const job = (over: Partial<ImportJobDto> = {}): ImportJobDto & { rows: unknown[] } => ({
  id: 'imp-1', organizationId: 'org-1', type: 'ORG_UNITS', source: 'upload', originalFilename: 'units.xlsx', status: 'VALIDATED', totalRows: 1, validRows: 1, errorRows: 0, importedRows: 0, options: {}, summary: null, error: null,
  queueJobId: null, requestedBy: 'u1', requestedByName: 'Dev', confirmedBy: null, confirmedAt: null, createdAt: '2026-10-19T08:00:00.000Z', updatedAt: '2026-10-19T08:00:00.000Z', rows: [], ...over,
});

describe('EmployeeImportPage — import kinds and Excel', () => {
  beforeEach(() => { resetApiMock(); });

  it('offers organisational units to department.manage holders and uploads an .xlsx with the chosen kind', async () => {
    grant('employee.import', 'employee.create', 'department.manage');
    mockGet({ '/orgs/org-1/user-limit': { data: limit } });
    apiMock.post.mockResolvedValue({ data: job() });
    renderWithProviders(<EmployeeImportPage />, { route: '/employees/import' });
    const units = await screen.findByRole('radio', { name: 'Organisational units' });
    expect(screen.getByRole('radio', { name: 'Employees' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(units);
    expect(units).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('parentCode')).toBeInTheDocument();
    expect(screen.queryByText('Update existing employees')).not.toBeInTheDocument();
    const input = document.getElementById('import-file') as HTMLInputElement;
    expect(input.accept).toContain('.xlsx');
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'units.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload and validate' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.post.mock.calls[0]! as [string, { fileName: string; kind: string; contentBase64: string }];
    expect(path).toBe('/orgs/org-1/employees/imports');
    expect(body).toMatchObject({ fileName: 'units.xlsx', kind: 'ORG_UNITS', contentBase64: 'UEsDBA==' });
  });

  it('shows only employees without department.manage', async () => {
    grant('employee.import', 'employee.create');
    mockGet({ '/orgs/org-1/user-limit': { data: limit } });
    renderWithProviders(<EmployeeImportPage />, { route: '/employees/import' });
    expect(await screen.findByText('Choose a CSV or Excel file or drop it here')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Organisational units' })).not.toBeInTheDocument();
    expect(screen.getByText('civilId')).toBeInTheDocument();
  });

  it('reviews an org-unit import with its own columns', async () => {
    grant('employee.import', 'employee.create', 'department.manage');
    mockGet({
      '/orgs/org-1/user-limit': { data: limit },
      '/orgs/org-1/employees/imports/imp-1': { data: job({ rows: [{ id: 'r1', rowNo: 2, data: { code: 'ER', name: 'Employee Relations', parentCode: 'HR' }, errors: [], status: 'valid', entityId: null }] } as never), meta: { page: 1, pageSize: 25, total: 1, totalPages: 1 } },
    });
    renderWithProviders(<EmployeeImportPage />, { route: '/employees/import?importId=imp-1' });
    expect((await screen.findAllByText('Employee Relations')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Parent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('HR').length).toBeGreaterThan(0);
  });
});
