import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { Braces, Link2, X } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useEmployeeOptions } from '@/features/employees/api';
import { useRawTransactions } from '@/features/attendance/api';
import { RawStatusBadge } from '@/features/attendance/components/badges';
import type { RawTransactionDto } from '@/features/attendance/types';
import { useDeviceOptions } from '../api';
import { PinMappingDialog, type PinMappingDraft } from './pin-mapping-dialog';
import { RawPunchDialog } from './raw-punch-dialog';

const ALL = '__all__';
const DEFAULT_DAYS = 14;
const MAPPINGS = ['mapped', 'unmapped'] as const;

/**
 * Devices & punches → Punch log: every raw punch received from the organisation's devices, newest first (cursor pages). Filter
 * by date (last two weeks by default), device, employee, PIN or mapping status; Raw opens the stored transaction and an unmapped
 * punch can be mapped to an employee right from its row.
 */
export function PunchLogPanel() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const table = useTabTable();
  const f = table.state.filters;
  const today = DateTime.now().setZone(tz).toISODate() ?? '';
  const from = f['from'] ?? DateTime.now().setZone(tz).minus({ days: DEFAULT_DAYS }).toISODate() ?? '';
  const to = f['to'] ?? today;
  const [cursors, setCursors] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const [pinInput, setPinInput] = useState(f['pin'] ?? '');
  const cursor = cursors[cursors.length - 1];
  const mapping = MAPPINGS.find((m) => m === f['mapping']);
  const query = useMemo(() => ({
    cursor, limit, deviceId: f['deviceId'], employeeId: f['employeeId'], deviceEmployeeId: f['pin'], mapping,
    from: from ? DateTime.fromISO(from, { zone: tz }).startOf('day').toUTC().toISO() ?? undefined : undefined,
    to: to ? DateTime.fromISO(to, { zone: tz }).endOf('day').toUTC().toISO() ?? undefined : undefined,
  }), [cursor, limit, f, mapping, from, to, tz]);
  const q = useRawTransactions(query);
  const devices = useDeviceOptions();
  const employees = useEmployeeOptions();
  const [employeeLabel, setEmployeeLabel] = useState<ComboboxOption | null>(null);
  const employeeOptions = useMemo(() => (employeeLabel && !employees.options.some((o) => o.value === employeeLabel.value) ? [employeeLabel, ...employees.options] : employees.options), [employees.options, employeeLabel]);
  const [open, setOpen] = useState<RawTransactionDto | null>(null);
  const [mapDraft, setMapDraft] = useState<PinMappingDraft | null>(null);
  const canMap = can('device.sync') || can('employee.update');
  const setFilters = (filters: Record<string, string | undefined>) => { setCursors([]); table.update({ filters: Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, v ?? ''])) }); };
  const hasFilters = ['deviceId', 'employeeId', 'pin', 'mapping', 'from', 'to'].some((k) => !!f[k]);
  const rows = q.data?.data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="punch-from" className="text-xs text-muted-foreground">{tc('common.from')}</Label>
          <Input id="punch-from" type="date" value={from} max={to || undefined} onChange={(e) => setFilters({ from: e.target.value || undefined })} className="h-8 w-[150px]" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="punch-to" className="text-xs text-muted-foreground">{tc('common.to')}</Label>
          <Input id="punch-to" type="date" value={to} min={from || undefined} onChange={(e) => setFilters({ to: e.target.value || undefined })} className="h-8 w-[150px]" dir="ltr" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="punch-device" className="text-xs text-muted-foreground">{t('punchLog.device')}</Label>
          <Combobox id="punch-device" value={f['deviceId'] ?? null} onChange={(v) => setFilters({ deviceId: v ?? undefined })} options={devices.options} loading={devices.isLoading} clearable placeholder={t('punchLog.allDevices')} className="h-8 w-48" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="punch-mapping" className="text-xs text-muted-foreground">{t('punchLog.mappingLabel')}</Label>
          <Select value={mapping ?? ALL} onValueChange={(v) => setFilters({ mapping: v === ALL ? undefined : v })}>
            <SelectTrigger id="punch-mapping" className="h-8 w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>{t('punchLog.mapping.all')}</SelectItem>{MAPPINGS.map((m) => <SelectItem key={m} value={m}>{t(`punchLog.mapping.${m}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="punch-employee" className="text-xs text-muted-foreground">{t('punchLog.employee')}</Label>
          <Combobox id="punch-employee" value={f['employeeId'] ?? null} onChange={(v) => { setEmployeeLabel(employeeOptions.find((o) => o.value === v) ?? null); setFilters({ employeeId: v ?? undefined }); }} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('punchLog.allEmployees')} className="h-8 w-52" />
        </div>
        <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); setFilters({ pin: pinInput.trim() || undefined }); }}>
          <Label htmlFor="punch-pin" className="text-xs text-muted-foreground">{t('punchLog.pin')}</Label>
          <Input id="punch-pin" value={pinInput} onChange={(e) => setPinInput(e.target.value)} onBlur={() => { if ((pinInput.trim() || undefined) !== f['pin']) setFilters({ pin: pinInput.trim() || undefined }); }} placeholder={t('punchLog.pinPlaceholder')} className="h-8 w-28 font-mono" dir="ltr" maxLength={64} />
        </form>
        {hasFilters ? <Button variant="ghost" size="sm" onClick={() => { setPinInput(''); setFilters({ deviceId: undefined, employeeId: undefined, pin: undefined, mapping: undefined, from: undefined, to: undefined }); }}><X /> {tc('common.clearFilters')}</Button> : null}
      </div>
      <div className="rounded-xl border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading && !rows ? <TableSkeleton cols={7} />
          : rows && rows.length === 0 ? <div className="p-4"><EmptyState title={t('punchLog.empty')} description={t('punchLog.emptyHint')} /></div>
          : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t('punchLog.columns.time')}</TableHead><TableHead>{t('punchLog.columns.device')}</TableHead><TableHead>{t('punchLog.columns.pin')}</TableHead>
                <TableHead>{t('punchLog.columns.employee')}</TableHead><TableHead>{t('punchLog.columns.state')}</TableHead><TableHead>{t('punchLog.columns.status')}</TableHead><TableHead className="text-end">{t('punchLog.columns.raw')}</TableHead>
              </TableRow></TableHeader>
              <TableBody className={cn(q.isFetching && 'opacity-60')}>
                {rows?.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-sm tnum">{fmtDateTime(r.punchedAt, r.deviceTimezone ?? tz, 'dd MMM yyyy, HH:mm:ss')}</TableCell>
                    <TableCell className="text-xs"><p className="font-mono text-muted-foreground" dir="ltr">{r.deviceSerial ?? r.deviceCode ?? '—'}</p>{r.deviceName ? <p className="max-w-[180px] truncate">{r.deviceName}</p> : null}</TableCell>
                    <TableCell className="font-mono text-sm tnum" dir="ltr">{r.deviceEmployeeId ?? '—'}</TableCell>
                    <TableCell className="text-sm">{r.employeeId
                      ? <span>{r.employeeName ?? '—'}{r.employeeNumber ? <span className="text-muted-foreground"> ({r.employeeNumber})</span> : null}</span>
                      : <span className="flex flex-wrap items-center gap-2"><Badge variant="danger">{t('punchLog.unmapped')}</Badge>{canMap && r.deviceId && r.deviceEmployeeId && r.source !== 'SELF_SERVICE' ? <Button size="sm" variant="outline" className="h-7" onClick={() => setMapDraft({ deviceId: r.deviceId, deviceUserId: r.deviceEmployeeId ?? '' })}><Link2 /> {t('punchLog.mapPin')}</Button> : null}</span>}
                    </TableCell>
                    <TableCell className="text-xs">{r.direction ? t(`punchLog.direction.${r.direction}`, { defaultValue: r.direction }) : '—'}{r.verificationMethod ? <span className="text-muted-foreground"> · {t(`punchLog.verify.${r.verificationMethod}`, { defaultValue: r.verificationMethod })}</span> : null}</TableCell>
                    <TableCell><RawStatusBadge status={r.processingStatus} /></TableCell>
                    <TableCell className="text-end"><Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(r)} aria-label={t('punchLog.openRaw', { id: r.id })}><Braces /> {t('punchLog.columns.raw')}</Button></TableCell>
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
          <span className="tnum">{t('punchLog.page', { page: cursors.length + 1 })}</span>
          <Button variant="outline" size="sm" disabled={!q.data?.meta.nextCursor} onClick={() => { const n = q.data?.meta.nextCursor; if (n) setCursors((c) => [...c, n]); }}>{tc('common.next')}</Button>
        </div>
      </div>
      {open ? <RawPunchDialog punch={open} tz={tz} onClose={() => setOpen(null)} /> : null}
      {mapDraft ? <PinMappingDialog draft={mapDraft} onClose={() => setMapDraft(null)} /> : null}
    </div>
  );
}
