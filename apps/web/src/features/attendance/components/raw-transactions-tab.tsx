import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { RotateCcw, X } from 'lucide-react';
import { RAW_PROCESSING_STATUSES } from '@flowza/contracts';
import { Button, EmptyState, ErrorState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { Combobox, DateRange } from '@/components/forms';
import { api, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useAttendanceMutations, useRawTransactions } from '../api';
import { RAW_ROW_CLASS, REQUEUEABLE } from '../status';
import type { RawTransactionDto } from '../types';
import { RawStatusBadge } from './badges';

const ALL = '__all__';
interface DeviceRef { id: string; name: string; code: string }
function useDeviceOptions(branchId?: string) {
  const orgId = useOrgId();
  const q = useQuery({ queryKey: qk.list(orgId, 'devices', { pageSize: 200, branchId }), queryFn: () => api.get<PageEnvelope<DeviceRef>>(`/orgs/${orgId}/devices`, { pageSize: 200, branchId }), staleTime: 60_000 });
  return { options: (q.data?.data ?? []).map((d) => ({ value: d.id, label: d.name, description: d.code })), isLoading: q.isLoading };
}

/** Raw device transactions (append-only) with cursor pagination; quarantined/unmatched/held rows are highlighted and can be re-queued. */
export function RawTransactionsTab() {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const table = useTabTable();
  const f = table.state.filters;
  const [cursors, setCursors] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const cursor = cursors[cursors.length - 1];
  const query = useMemo(() => ({
    cursor, limit, deviceId: f['deviceId'], branchId: f['branchId'], processingStatus: f['processingStatus'], deviceEmployeeId: f['deviceEmployeeId'],
    from: f['from'] ? DateTime.fromISO(f['from'], { zone: tz }).startOf('day').toUTC().toISO() ?? undefined : undefined,
    to: f['to'] ? DateTime.fromISO(f['to'], { zone: tz }).endOf('day').toUTC().toISO() ?? undefined : undefined,
  }), [cursor, limit, f, tz]);
  const q = useRawTransactions(query);
  const branches = useBranchOptions();
  const devices = useDeviceOptions(f['branchId']);
  const { requeueRaw } = useAttendanceMutations();
  const canRequeue = can('attendance.correct', 'attendance.view_raw');
  const hasFilters = ['deviceId', 'branchId', 'processingStatus', 'deviceEmployeeId', 'from', 'to'].some((k) => !!f[k]);
  const setFilter = (k: string, v: string | undefined) => { setCursors([]); table.setFilter(k, v); };
  const [deviceEmployeeId, setDeviceEmployeeId] = useState(f['deviceEmployeeId'] ?? '');
  const requeue = (r: RawTransactionDto) => requeueRaw.mutate(r.id, { onSuccess: () => toast.success(t('raw.requeued')), onError: toastError });
  const rows = q.data?.data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Combobox value={f['branchId'] ?? null} onChange={(v) => { setCursors([]); table.update({ filters: { branchId: v ?? '', deviceId: '' } }); }} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
        <Combobox value={f['deviceId'] ?? null} onChange={(v) => setFilter('deviceId', v ?? undefined)} options={devices.options} loading={devices.isLoading} clearable placeholder={t('raw.device')} className="h-8 w-44" />
        <Select value={f['processingStatus'] ?? ALL} onValueChange={(v) => setFilter('processingStatus', v === ALL ? undefined : v)}>
          <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>{RAW_PROCESSING_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`rawStatus.${s}`)}</SelectItem>)}</SelectContent>
        </Select>
        <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); setFilter('deviceEmployeeId', deviceEmployeeId.trim() || undefined); }}>
          <Input value={deviceEmployeeId} onChange={(e) => setDeviceEmployeeId(e.target.value)} placeholder={t('raw.deviceEmployeeId')} aria-label={t('raw.deviceEmployeeId')} className="h-8 w-36 font-mono" dir="ltr" />
        </form>
        <DateRange idPrefix="raw" from={f['from']} to={f['to']} onChange={({ from, to }) => { setCursors([]); table.update({ filters: { from: from ?? '', to: to ?? '' } }); }} />
        {hasFilters ? <Button variant="ghost" size="sm" onClick={() => { setCursors([]); setDeviceEmployeeId(''); table.update({ filters: { deviceId: '', branchId: '', processingStatus: '', deviceEmployeeId: '', from: '', to: '' } }); }}><X /> {tc('common.clearFilters')}</Button> : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('raw.hint')}</p>
      <div className="rounded-lg border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading && !rows ? <TableSkeleton cols={7} />
          : rows && rows.length === 0 ? <div className="p-4"><EmptyState title={t('raw.empty')} description={hasFilters ? tc('common.noResultsHint') : t('raw.emptyHint')} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{t('raw.punchedAt')}</TableHead><TableHead>{t('raw.deviceLocal')}</TableHead><TableHead>{t('raw.device')}</TableHead><TableHead>{t('raw.deviceEmployeeId')}</TableHead><TableHead>{t('columns.employee')}</TableHead><TableHead>{t('raw.direction')}</TableHead><TableHead>{t('raw.source')}</TableHead><TableHead>{tc('common.status')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
              <TableBody className={cn(q.isFetching && 'opacity-60')}>
                {rows?.map((r) => (
                  <TableRow key={r.id} className={RAW_ROW_CLASS[r.processingStatus]}>
                    <TableCell className="whitespace-nowrap font-mono text-xs tnum" dir="ltr">{fmtDateTime(r.punchedAt, tz, 'dd MMM yyyy, HH:mm:ss')}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground" dir="ltr">{r.deviceLocalTime ?? '—'}{r.clockSkewSeconds && Math.abs(r.clockSkewSeconds) > 60 ? <span className="ms-1 text-amber-700" title={t('raw.skew', { seconds: r.clockSkewSeconds })}>⚠</span> : null}</TableCell>
                    <TableCell className="text-xs">{r.deviceName ?? r.deviceId?.slice(0, 8) ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">{r.deviceEmployeeId ?? '—'}</TableCell>
                    <TableCell className="text-xs">{r.employeeName ?? <span className="text-muted-foreground">{t('raw.unmatchedEmployee')}</span>}</TableCell>
                    <TableCell className="text-xs">{r.direction ?? '—'}{r.verificationMethod ? <span className="text-muted-foreground"> · {r.verificationMethod}</span> : null}</TableCell>
                    <TableCell className="text-xs">{r.source}</TableCell>
                    <TableCell><div className="flex flex-col gap-0.5"><RawStatusBadge status={r.processingStatus} />{r.processingError ? <span className="max-w-[200px] truncate text-[11px] text-destructive" title={r.processingError}>{r.processingError}</span> : null}</div></TableCell>
                    <TableCell className="text-end">{canRequeue && REQUEUEABLE.has(r.processingStatus) ? <Button size="sm" variant="outline" loading={requeueRaw.isPending && requeueRaw.variables === r.id} onClick={() => requeue(r)}><RotateCcw /> {t('raw.requeue')}</Button> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
      <div className="flex flex-col items-center justify-between gap-2 text-sm text-muted-foreground sm:flex-row">
        <div className="flex items-center gap-2">
          <span>{tc('common.rowsPerPage')}</span>
          <Select value={String(limit)} onValueChange={(v) => { setCursors([]); setLimit(Number(v)); }}>
            <SelectTrigger className="h-8 w-[76px]"><SelectValue /></SelectTrigger>
            <SelectContent>{[25, 50, 100, 200].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>{tc('common.previous')}</Button>
          <span className="tnum">{t('raw.page', { page: cursors.length + 1 })}</span>
          <Button variant="outline" size="sm" disabled={!q.data?.meta.nextCursor} onClick={() => { const n = q.data?.meta.nextCursor; if (n) setCursors((c) => [...c, n]); }}>{tc('common.next')}</Button>
        </div>
      </div>
    </div>
  );
}
