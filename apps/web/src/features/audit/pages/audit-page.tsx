import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { FileText, X } from 'lucide-react';
import type { AuditLogDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox, DateRange } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { SearchBox } from '@/features/organization/components/search-box';
import { useMembers } from '@/features/users/api';
import { AUDIT_ENTITY_TYPES, useAuditLogs } from '../api';
import { AuditDetailDialog } from '../components/audit-detail-dialog';
import { CopyButton } from '../components/copy-button';

const ALL = '__all__';
const ACTOR_TONE: Record<string, 'info' | 'warning' | 'neutral' | 'success'> = { USER: 'info', PLATFORM_ADMIN: 'warning', SYSTEM: 'neutral', DEVICE: 'success' };

export default function AuditPage() {
  const { t } = useTranslation('audit');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const table = useServerTable({ sort: 'createdAt', order: 'desc' });
  const f = table.state.filters;
  const query = useMemo(() => ({
    page: table.state.page, pageSize: table.state.pageSize, sort: table.state.sort, order: table.state.order,
    entityType: f['entityType'], action: f['action'], actorUserId: f['actorUserId'], entityId: f['entityId'],
    from: f['fromDate'] ? DateTime.fromISO(f['fromDate'], { zone: tz }).startOf('day').toUTC().toISO() ?? undefined : undefined,
    to: f['toDate'] ? DateTime.fromISO(f['toDate'], { zone: tz }).endOf('day').toUTC().toISO() ?? undefined : undefined,
  }), [table.state, f, tz]);
  const q = useAuditLogs(query);
  const [actorSearch, setActorSearch] = useState('');
  const members = useMembers({ search: actorSearch || undefined, pageSize: 20, sort: 'fullName' });
  const actorOptions = useMemo(() => (members.data?.data ?? []).map((m) => ({ value: m.userId, label: m.fullName || m.email, description: m.email })), [members.data]);
  const [selected, setSelected] = useState<AuditLogDto | null>(null);
  const hasFilters = Object.keys(f).length > 0;

  const columns = useMemo<ColumnDef<AuditLogDto, unknown>[]>(() => [
    { id: 'createdAt', accessorKey: 'createdAt', header: t('columns.time'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz, 'dd MMM yyyy, HH:mm:ss')}</span> },
    { id: 'actor', header: t('columns.actor'), enableSorting: false, cell: ({ row }) => <div className="flex min-w-0 items-center gap-2"><Badge variant={ACTOR_TONE[row.original.actorType] ?? 'neutral'}>{t(`actorTypes.${row.original.actorType}`, { defaultValue: row.original.actorType })}</Badge><span className="truncate">{row.original.actorName ?? row.original.actorLabel ?? '—'}</span></div> },
    { id: 'action', accessorKey: 'action', header: t('columns.action'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.action}</span> },
    { id: 'entityType', accessorKey: 'entityType', header: t('columns.entityType'), cell: ({ row }) => <Badge variant="secondary">{row.original.entityType}</Badge> },
    { id: 'entityId', header: t('columns.entityId'), enableSorting: false, cell: ({ row }) => row.original.entityId ? <span className="font-mono text-xs text-muted-foreground" dir="ltr" title={row.original.entityId}>{row.original.entityId.slice(0, 8)}…</span> : '—' },
    { id: 'requestId', header: t('columns.requestId'), enableSorting: false, cell: ({ row }) => row.original.requestId ? <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground" dir="ltr" onClick={(e) => e.stopPropagation()}>{row.original.requestId.slice(0, 8)}…<CopyButton value={row.original.requestId} size="sm" className="size-6" label={t('copyRequestId')} /></span> : '—' },
    { id: 'changes', header: t('columns.changes'), enableSorting: false, cell: ({ row }) => (row.original.oldValue || row.original.newValue) ? <Button variant="link" size="sm" className="h-auto p-0" onClick={(e) => { e.stopPropagation(); setSelected(row.original); }}>{t('viewDiff')}</Button> : <span className="text-xs text-muted-foreground">—</span> },
  ], [t, tz]);

  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} sort={table.state.sort} order={table.state.order} onSort={table.toggleSort}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="audit"
        onRowClick={setSelected}
        emptyTitle={t('empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('emptyHint')}
        toolbar={
          <>
            <Select value={f['entityType'] ?? ALL} onValueChange={(v) => table.setFilter('entityType', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-44" aria-label={t('columns.entityType')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allEntities')}</SelectItem>{AUDIT_ENTITY_TYPES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
            </Select>
            <SearchBox id="audit-action" value={f['action']} onChange={(v) => table.setFilter('action', v)} placeholder={t('filters.actionPlaceholder')} className="relative w-full sm:w-52" />
            <Combobox value={f['actorUserId'] ?? null} onChange={(v) => table.setFilter('actorUserId', v ?? undefined)} options={actorOptions} onSearch={setActorSearch} loading={members.isLoading} clearable placeholder={t('filters.anyActor')} className="h-8 w-48" />
            <DateRange idPrefix="audit" from={f['fromDate']} to={f['toDate']} onChange={({ from, to }) => table.update({ filters: { fromDate: from ?? '', toDate: to ?? '' } })} />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(a) => <div className="flex items-start gap-3"><FileText className="mt-0.5 size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-mono text-xs" dir="ltr">{a.action}</p><p className="text-xs text-muted-foreground">{a.actorName ?? a.actorLabel ?? '—'} · <span className="tnum">{fmtDateTime(a.createdAt, tz)}</span></p></div><Badge variant="secondary">{a.entityType}</Badge></div>}
      />
      <AuditDetailDialog entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
