import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { PlatformUserDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { SearchBox } from '@/features/organization/components/search-box';
import { OrgStatusBadge } from '@/features/platform/components/org-status-badge';
import { usePlatformUser, usePlatformUsers } from '../api';

const ALL = '__all__';

function UserDialog({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { t } = useTranslation('adm');
  const q = usePlatformUser(userId);
  const u = q.data;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="lg">
        {q.isLoading ? <Skeleton className="h-48 w-full" /> : q.isError || !u ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <DialogHeader>
              <DialogTitle>{u.fullName || u.email}</DialogTitle>
              <DialogDescription dir="ltr" className="text-start">{u.email}</DialogDescription>
            </DialogHeader>
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-muted-foreground">{t('users.platformRole')}</dt><dd>{u.platformAdminLevel ? <Badge variant="warning">{t(`levels.${u.platformAdminLevel}`)}{u.platformAdminStatus === 'disabled' ? ` · ${t('team.statuses.disabled')}` : ''}</Badge> : t('users.none')}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('users.mfa')}</dt><dd>{u.mfaEnrolled ? <Badge variant="success">{t('mfaOn')}</Badge> : <Badge variant="neutral">{t('mfaOff')}</Badge>}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('users.lastLogin')}</dt><dd className="tnum">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt, 'UTC') : t('members.never')}</dd></div>
              <div><dt className="text-xs text-muted-foreground">{t('users.created')}</dt><dd className="tnum">{fmtDateTime(u.createdAt, 'UTC', 'dd MMM yyyy')}</dd></div>
            </dl>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('users.memberships')}</p>
              {u.memberships.length === 0 ? <p className="text-sm text-muted-foreground">{t('users.noMemberships')}</p> : (
                <ul className="divide-y rounded-lg border">
                  {u.memberships.map((m) => (
                    <li key={m.membershipId}>
                      <Link to={`/adm/tenants/${m.organizationId}?tab=members`} onClick={onClose} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{m.organizationName}</p><p className="truncate text-xs text-muted-foreground">{m.roleName} · <span className="font-mono" dir="ltr">{m.companyCode}</span></p></div>
                        <Badge variant={m.status === 'active' ? 'success' : 'neutral'}>{t(`members.statuses.${m.status}`, { defaultValue: m.status })}</Badge>
                        <OrgStatusBadge status={m.organizationStatus} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function AdmUsersPage() {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const table = useServerTable({});
  const [params, setParams] = useSearchParams();
  const { user: _user, ...query } = table.query as typeof table.query & { user?: string };
  const q = usePlatformUsers(query);
  const openUser = params.get('user');
  const setOpen = (id: string | null) => setParams((prev) => { const n = new URLSearchParams(prev); if (id) n.set('user', id); else n.delete('user'); return n; }, { replace: true });
  const filters = table.state.filters;
  const columns = useMemo<ColumnDef<PlatformUserDto, unknown>[]>(() => [
    { id: 'email', header: t('users.email'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.fullName || '—'}</p><p className="truncate text-xs text-muted-foreground" dir="ltr">{row.original.email}</p></div> },
    { id: 'tenants', header: t('users.tenants'), enableSorting: false, cell: ({ row }) => <span className="tnum">{row.original.membershipCount}</span> },
    { id: 'role', header: t('users.platformRole'), enableSorting: false, cell: ({ row }) => row.original.platformAdminLevel ? <Badge variant={row.original.platformAdminStatus === 'active' ? 'warning' : 'neutral'}>{t(`levels.${row.original.platformAdminLevel}`)}</Badge> : <span className="text-muted-foreground">—</span> },
    { id: 'mfa', header: t('users.mfa'), enableSorting: false, cell: ({ row }) => row.original.mfaEnrolled ? <Badge variant="success">{t('mfaOn')}</Badge> : <Badge variant="neutral">{t('mfaOff')}</Badge> },
    { id: 'status', header: tc('common.status'), enableSorting: false, cell: ({ row }) => <Badge variant={row.original.status === 'active' ? 'success' : 'danger'}>{t(`users.statuses.${row.original.status}`, { defaultValue: row.original.status })}</Badge> },
    { id: 'lastLoginAt', header: t('users.lastLogin'), cell: ({ row }) => <span className="text-xs tnum">{row.original.lastLoginAt ? fmtRelative(row.original.lastLoginAt) : t('members.never')}</span> },
    { id: 'createdAt', header: t('users.created'), cell: ({ row }) => <span className="text-xs tnum">{fmtDateTime(row.original.createdAt, 'UTC', 'dd MMM yyyy')}</span> },
  ], [t, tc]);
  return (
    <div className="page-container">
      <PageHeader title={t('users.title')} description={t('users.subtitle')} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="adm-users" onRowClick={(u) => setOpen(u.id)}
        emptyTitle={tc('common.noResults')}
        toolbar={<>
          <SearchBox value={filters['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('users.searchPlaceholder')} />
          <Select value={filters['platformAdmin'] ?? ALL} onValueChange={(v) => table.setFilter('platformAdmin', v === ALL ? undefined : v)}>
            <SelectTrigger className="h-8 w-40" aria-label={t('users.platformRole')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>{t('users.all')}</SelectItem><SelectItem value="true">{t('users.adminsOnly')}</SelectItem><SelectItem value="false">{t('users.nonAdmins')}</SelectItem></SelectContent>
          </Select>
        </>}
        renderCard={(u) => <div className="min-w-0"><p className="truncate font-medium">{u.fullName || u.email}</p><p className="truncate text-xs text-muted-foreground" dir="ltr">{u.email}</p></div>}
      />
      {openUser ? <UserDialog userId={openUser} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
