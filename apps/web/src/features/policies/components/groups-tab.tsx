import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import type { EmployeeGroupDto } from '@flowza/contracts';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useDebounced } from '@/hooks/use-debounced';
import { useActiveMembership, useCan } from '@/features/me/use-me';
import { RowActions } from '@/features/organization/components/row-actions';
import { POLICIES_NS } from '../i18n';
import { useEmployeeGroupMutations, useEmployeeGroups } from '../api';
import { GroupDialog } from './group-dialog';
import { MembersDialog } from './members-dialog';

const ALL = '__all__';

/** Employee groups: the "employee group" dimension of the policy scope (Office Staff, Sales Staff…) and their members. */
export function GroupsTab() {
  const { t, i18n } = useTranslation(POLICIES_NS);
  const { t: tc } = useTranslation();
  const can = useCan();
  const membership = useActiveMembership();
  // groups are organisation-wide: changing them needs attendance.manage_rules on every branch (the API refuses otherwise)
  const canManageGroups = can('attendance.manage_rules') && (membership?.allBranches ?? false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('active');
  const debounced = useDebounced(search, 250);
  const query = useMemo(() => ({ search: debounced || undefined, status: status === ALL ? undefined : status }), [debounced, status]);
  const q = useEmployeeGroups(query);
  const { remove } = useEmployeeGroupMutations();
  const [dialog, setDialog] = useState<{ open: boolean; group: EmployeeGroupDto | null }>({ open: false, group: null });
  const [members, setMembers] = useState<EmployeeGroupDto | null>(null);
  const [deleting, setDeleting] = useState<EmployeeGroupDto | null>(null);
  const name = (g: EmployeeGroupDto) => (i18n.language === 'ar' && g.nameAr ? g.nameAr : g.name);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tc('common.searchPlaceholder')} aria-label={tc('common.search')} className="h-8 w-56" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-40" aria-label={t('groups.status')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('groups.allStatuses')}</SelectItem>{(['active', 'inactive'] as const).map((s) => <SelectItem key={s} value={s}>{t(`groups.statuses.${s}`)}</SelectItem>)}</SelectContent>
        </Select>
        {canManageGroups ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, group: null })}><Plus /> {t('groups.add')}</Button> : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('groups.hint')}</p>
      <div className="rounded-xl border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading && !q.data ? <TableSkeleton cols={6} rows={4} />
          : q.data && q.data.length === 0 ? <div className="p-4"><EmptyState icon={Users} title={t('groups.empty')} description={t('groups.emptyHint')} action={canManageGroups ? <Button onClick={() => setDialog({ open: true, group: null })}><Plus /> {t('groups.add')}</Button> : undefined} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{tc('common.name')}</TableHead><TableHead>{tc('common.code')}</TableHead><TableHead>{t('groups.members')}</TableHead><TableHead>{t('groups.policies')}</TableHead><TableHead>{t('groups.status')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data?.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell><button type="button" className="font-medium hover:underline" onClick={() => setMembers(g)}>{name(g)}</button>{g.description ? <p className="max-w-xs truncate text-xs text-muted-foreground" title={g.description}>{g.description}</p> : null}</TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">{g.code}</TableCell>
                    <TableCell className="tnum">{g.memberCount}</TableCell>
                    <TableCell className="tnum">{g.policyCount}</TableCell>
                    <TableCell><Badge variant={g.status === 'active' ? 'success' : 'neutral'}>{t(`groups.statuses.${g.status}`, { defaultValue: g.status })}</Badge></TableCell>
                    <TableCell>
                      <RowActions actions={[
                        { key: 'members', label: t('groups.manageMembers'), icon: <Users />, onSelect: () => setMembers(g) },
                        ...(canManageGroups ? [
                          { key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, group: g }) },
                          { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(g) },
                        ] : []),
                      ]} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
      <GroupDialog key={`${dialog.open}-${dialog.group?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} group={dialog.group} />
      <MembersDialog key={members?.id ?? 'none'} group={members} onOpenChange={(o) => !o && setMembers(null)} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('groups.deleteTitle', { name: deleting?.name ?? '' })} description={deleting && deleting.policyCount > 0 ? t('groups.deleteBlocked', { count: deleting.policyCount }) : t('groups.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('groups.deleted')); setDeleting(null); }, onError: (e) => { toastError(e); setDeleting(null); } }); }} />
    </div>
  );
}
