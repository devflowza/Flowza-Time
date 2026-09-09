import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Link2, ScanLine, X } from 'lucide-react';
import type { UnmappedDeviceUserDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useDeviceOptions, useUnmappedDeviceUsers } from '../api';
import { LinkDeviceUserDialog, type LinkTarget } from '../components/link-device-user-dialog';

type Origin = 'all' | 'punches' | 'enrolled';

/**
 * Every device user id (the PIN people type on the keypad) that no employee answers for — the queue behind "unmatched"
 * raw transactions. Linking one here attaches the punches it has already collected to a person and replays them through
 * the attendance engine, so the days it covers stop reading as absent.
 */
export default function UnmappedUsersPage() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Origin>('all');
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState<LinkTarget | null>(null);
  const branches = useBranchOptions();
  const devices = useDeviceOptions(branchId);
  const canLink = can('device.sync');

  const query = useMemo(() => ({ page, pageSize, branchId: branchId ?? undefined, deviceId: deviceId ?? undefined, origin, search }), [page, pageSize, branchId, deviceId, origin, search]);
  const q = useUnmappedDeviceUsers(query);
  const reset = (fn: () => void) => { fn(); setPage(1); };

  const columns = useMemo<ColumnDef<UnmappedDeviceUserDto, unknown>[]>(() => [
    { id: 'deviceUserId', header: t('unmapped.deviceUserId'), cell: ({ row }) => (
      <div className="min-w-0">
        <p className="font-mono text-sm tnum" dir="ltr">{row.original.deviceUserId}</p>
        {row.original.deviceUserName ? <p className="truncate text-xs text-muted-foreground">{row.original.deviceUserName}</p> : null}
      </div>
    ) },
    { id: 'device', header: t('unmapped.device'), cell: ({ row }) => (
      <div className="min-w-0">
        <Link to={`/devices/${row.original.deviceId}`} className="truncate font-medium hover:underline">{row.original.deviceName}</Link>
        <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{row.original.deviceCode} · {row.original.providerKey}</p>
      </div>
    ) },
    { id: 'origin', header: t('unmapped.origin'), cell: ({ row }) => (
      <div className="flex flex-wrap items-center gap-1">
        {row.original.unmatchedPunches > 0 ? <Badge variant="danger">{t('unmapped.punches', { count: row.original.unmatchedPunches })}</Badge> : null}
        {row.original.enrolledOnDevice ? <Badge variant="warning">{t('unmapped.enrolled')}</Badge> : null}
      </div>
    ) },
    { id: 'firstPunchAt', header: t('unmapped.firstSeen'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum" dir="ltr">{row.original.firstPunchAt ? fmtDateTime(row.original.firstPunchAt, tz, 'dd MMM yyyy, HH:mm') : '—'}</span> },
    { id: 'lastPunchAt', header: t('unmapped.lastSeen'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum" title={row.original.lastPunchAt ? fmtDateTime(row.original.lastPunchAt, tz) : ''}>{row.original.lastPunchAt ? fmtRelative(row.original.lastPunchAt) : '—'}</span> },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => (canLink ? (
      <Button size="sm" onClick={() => setTarget({ deviceId: row.original.deviceId, deviceUserId: row.original.deviceUserId, deviceName: row.original.deviceName, deviceUserName: row.original.deviceUserName, providerKey: row.original.providerKey, unmatchedPunches: row.original.unmatchedPunches })}>
        <Link2 /> {t('unmapped.link')}
      </Button>
    ) : null) },
  ], [t, tz, canLink]);

  const waiting = (q.data?.data ?? []).reduce((n, r) => n + r.unmatchedPunches, 0);
  const hasFilters = !!branchId || !!deviceId || origin !== 'all' || !!search;

  return (
    <div className="page-container">
      <PageHeader
        title={t('unmapped.title')}
        description={t('unmapped.subtitle')}
        actions={waiting > 0 ? <Badge variant="danger" className="tnum"><ScanLine className="me-1 size-3.5" /> {t('unmapped.waiting', { count: waiting, punches: fmtNumber(waiting) })}</Badge> : undefined}
      />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="unmapped-device-users"
        emptyTitle={t('unmapped.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('unmapped.emptyHint')}
        toolbar={<>
          <SearchBox value={search} onChange={(v) => reset(() => setSearch(v))} placeholder={t('unmapped.searchPlaceholder')} />
          <Combobox value={branchId} onChange={(v) => reset(() => { setBranchId(v); setDeviceId(null); })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
          <Combobox value={deviceId} onChange={(v) => reset(() => setDeviceId(v))} options={devices.options} loading={devices.isLoading} clearable placeholder={t('unmapped.device')} className="h-8 w-44" />
          <Select value={origin} onValueChange={(v) => reset(() => setOrigin(v as Origin))}>
            <SelectTrigger className="h-8 w-44" aria-label={t('unmapped.origin')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('unmapped.originAll')}</SelectItem>
              <SelectItem value="punches">{t('unmapped.originPunches')}</SelectItem>
              <SelectItem value="enrolled">{t('unmapped.originEnrolled')}</SelectItem>
            </SelectContent>
          </Select>
          {hasFilters ? <Button variant="ghost" size="sm" onClick={() => reset(() => { setBranchId(null); setDeviceId(null); setOrigin('all'); setSearch(undefined); })}><X /> {tc('common.clearFilters')}</Button> : null}
        </>}
      />
      {target ? <LinkDeviceUserDialog target={target} onClose={() => setTarget(null)} /> : null}
    </div>
  );
}
