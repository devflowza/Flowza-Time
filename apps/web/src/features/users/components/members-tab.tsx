import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Ban, Pencil, UserPlus, X } from 'lucide-react';
import { MEMBERSHIP_STATUSES, type MemberDto, type MembershipStatus } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Avatar, Badge, Button, ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useActiveMembership, useCan, useOrgTimezone } from '@/features/me/use-me';
import { SearchBox } from '@/features/organization/components/search-box';
import { RowActions } from '@/features/organization/components/row-actions';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useMemberMutations, useMembers, useRoles } from '../api';
import { MemberDialog } from './member-dialog';
import { InviteDialog } from './invite-dialog';

const ALL = '__all__';
const STATUS_TONE: Record<MembershipStatus, 'success' | 'info' | 'danger'> = { active: 'success', invited: 'info', suspended: 'danger' };

export function MembersTab() {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('user.manage');
  const tz = useOrgTimezone();
  const me = useActiveMembership();
  const table = useTabTable({ sort: 'fullName' });
  const q = useMembers(table.query);
  const roles = useRoles();
  const { suspend } = useMemberMutations();
  const [editing, setEditing] = useState<MemberDto | null>(null);
  const [suspending, setSuspending] = useState<MemberDto | null>(null);
  const [inviting, setInviting] = useState(false);
  const filters = table.state.filters;

  const columns = useMemo<ColumnDef<MemberDto, unknown>[]>(() => [
    { id: 'fullName', accessorKey: 'fullName', header: tc('common.name'), cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={row.original.fullName || row.original.email} />
        <div className="min-w-0"><p className="truncate font-medium">{row.original.fullName || '—'}{row.original.id === me?.membershipId ? <span className="ms-1 text-xs text-muted-foreground">({t('members.you')})</span> : null}</p><p className="truncate text-xs text-muted-foreground" dir="ltr">{row.original.email}</p></div>
      </div>
    ) },
    { id: 'role', header: t('fields.role'), cell: ({ row }) => <span className="inline-flex items-center gap-1">{row.original.roleName}{row.original.roleKey === 'owner' ? <Badge variant="warning">{t('roles.owner')}</Badge> : null}</span> },
    { id: 'scope', header: t('fields.branchScope'), enableSorting: false, cell: ({ row }) => row.original.allBranches ? <Badge variant="outline">{t('fields.allBranches')}</Badge> : <span className="flex flex-wrap gap-1">{(row.original.branchNames ?? row.original.branchIds).slice(0, 3).map((b) => <Badge key={b} variant="secondary">{b}</Badge>)}{row.original.branchIds.length > 3 ? <Badge variant="secondary">+{row.original.branchIds.length - 3}</Badge> : null}</span> },
    { id: 'employee', header: t('fields.linkEmployee'), enableSorting: false, cell: ({ row }) => row.original.employeeNumber ? <span className="font-mono text-xs" dir="ltr">{row.original.employeeNumber}</span> : '—' },
    { id: 'status', accessorKey: 'status', header: tc('common.status'), cell: ({ row }) => <Badge variant={STATUS_TONE[row.original.status]} dot>{t(`status.${row.original.status}`)}</Badge> },
    { id: 'lastLogin', header: t('fields.lastLogin'), enableSorting: false, cell: ({ row }) => <span className="text-xs tnum">{fmtDateTime(row.original.lastLoginAt, tz)}</span> },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => canManage ? <RowActions actions={[
      { key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setEditing(row.original) },
      { key: 'suspend', label: t('members.suspend'), icon: <Ban />, destructive: true, disabled: row.original.status === 'suspended' || row.original.id === me?.membershipId, onSelect: () => setSuspending(row.original) },
    ]} /> : null },
  ], [t, tc, tz, canManage, me?.membershipId]);

  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="members"
        onRowClick={canManage ? setEditing : undefined}
        emptyTitle={t('members.empty')} emptyDescription={t('members.emptyHint')}
        toolbar={
          <>
            <SearchBox value={filters['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('members.searchPlaceholder')} />
            <Select value={filters['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-36" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>{MEMBERSHIP_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={filters['roleId'] ?? ALL} onValueChange={(v) => table.setFilter('roleId', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-44" aria-label={t('fields.role')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allRoles')}</SelectItem>{(roles.data ?? []).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
            </Select>
            {Object.keys(filters).some((k) => k !== 'tab') ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
            {canManage ? <Button size="sm" className="ms-auto" onClick={() => setInviting(true)}><UserPlus /> {t('invite.title')}</Button> : null}
          </>
        }
        renderCard={(m) => <div className="flex items-center gap-3"><Avatar name={m.fullName || m.email} /><div className="min-w-0 flex-1"><p className="truncate font-medium">{m.fullName}</p><p className="truncate text-xs text-muted-foreground" dir="ltr">{m.email} · {m.roleName}</p></div><Badge variant={STATUS_TONE[m.status]} dot>{t(`status.${m.status}`)}</Badge></div>}
      />
      {editing ? <MemberDialog key={editing.id} member={editing} onClose={() => setEditing(null)} /> : null}
      {inviting ? <InviteDialog open onOpenChange={setInviting} /> : null}
      <ConfirmDialog open={!!suspending} onOpenChange={(o) => !o && setSuspending(null)} title={t('members.suspendTitle', { name: suspending?.fullName ?? '' })} description={t('members.suspendHint')} confirmLabel={t('members.suspend')} destructive loading={suspend.isPending}
        onConfirm={() => suspending && suspend.mutate(suspending.id, { onSuccess: () => { toast.success(t('members.suspended')); setSuspending(null); }, onError: toastError })} />
    </>
  );
}
