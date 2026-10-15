import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import type { AccessEventDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Label, Switch } from '@/components/ui';
import { Combobox, DateRange, type ComboboxOption } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useAccessEvents, useMeetingRooms } from '../api';
import { MEETINGS_NS } from '../i18n';
import { ISO_DATE } from '../model';
import { UnauthorizedBadge } from './badges';

/**
 * The room access log (meeting.rooms): every entry through a meeting-room reader, newest first — who (or which unknown card),
 * which room and reader, the meeting it belongs to, and whether the entry was unauthorised. Filters live in the address
 * (`from`, `to`, `room`, `unauthorized`), default the last seven days; the dates are the entries' local dates and the API pages
 * and filters them. Times show in the room's zone (`room.timezone`), the organisation's only for a room not in the list.
 */
export function AccessTab() {
  const { t } = useTranslation(MEETINGS_NS);
  const orgTz = useOrgTimezone();
  const table = useServerTable({ pageSize: 50 });
  const f = table.state.filters;
  const today = todayIso(orgTz);
  const defaultFrom = DateTime.fromISO(today).minus({ days: 6 }).toISODate()!;
  const from = f['from'] && ISO_DATE.test(f['from']) ? f['from'] : defaultFrom;
  const to = f['to'] && ISO_DATE.test(f['to']) ? f['to'] : today;
  const roomId = f['room'] || undefined;
  const unauthorizedOnly = f['unauthorized'] === '1';
  const pageSize = Math.min(table.state.pageSize, 200);
  const rooms = useMeetingRooms();
  const q = useAccessEvents({ from, to: to < from ? from : to, roomId, unauthorizedOnly, page: table.state.page, pageSize });
  const roomZone = useMemo(() => new Map((rooms.data ?? []).map((r) => [r.id, r.timezone])), [rooms.data]);
  const zoneOfEvent = (e: AccessEventDto) => (e.roomId ? roomZone.get(e.roomId) : undefined) ?? orgTz;
  const roomOptions = useMemo<ComboboxOption[]>(() => (rooms.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.locationName ?? undefined })), [rooms.data]);

  const person = (e: AccessEventDto) => e.employeeName ?? <span className="font-mono text-xs text-muted-foreground" dir="ltr">{t('access.unknownCard', { id: e.deviceEmployeeId })}</span>;
  const columns: ColumnDef<AccessEventDto, unknown>[] = [
    { id: 'time', header: t('access.columns.time'), cell: ({ row }) => <span className="whitespace-nowrap tnum">{fmtDateTime(row.original.occurredAt, zoneOfEvent(row.original), 'dd MMM, HH:mm:ss')}</span> },
    { id: 'room', header: t('access.columns.room'), cell: ({ row }) => row.original.roomName ?? '—' },
    { id: 'reader', header: t('access.columns.reader'), cell: ({ row }) => <span className="text-sm">{row.original.deviceName ?? '—'}</span> },
    { id: 'person', header: t('access.columns.person'), cell: ({ row }) => person(row.original) },
    { id: 'meeting', header: t('access.columns.meeting'), cell: ({ row }) => row.original.meetingTitle ?? <span className="text-muted-foreground">—</span> },
    { id: 'unauthorized', header: '', enableHiding: false, cell: ({ row }) => (row.original.unauthorized ? <UnauthorizedBadge /> : null) },
  ];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('access.hint')}</p>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        emptyTitle={t('access.empty')} emptyDescription={t('access.emptyHint')}
        toolbar={
          <>
            <DateRange idPrefix="access" from={from} to={to} onChange={(r) => table.update({ filters: { from: r.from ?? '', to: r.to ?? '' } })} />
            <Combobox value={roomId ?? null} onChange={(v) => table.setFilter('room', v ?? undefined)} options={roomOptions} loading={rooms.isLoading} clearable placeholder={t('access.allRooms')} aria-label={t('access.columns.room')} className="h-8 w-48 self-end" />
            <div className="flex items-center gap-2 self-end pb-1.5">
              <Switch id="access-unauthorized" checked={unauthorizedOnly} onCheckedChange={(v) => table.setFilter('unauthorized', v ? '1' : undefined)} />
              <Label htmlFor="access-unauthorized" className="text-sm font-normal">{t('access.unauthorizedOnly')}</Label>
            </div>
          </>
        }
        renderCard={(e) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{person(e)}</span>{e.unauthorized ? <UnauthorizedBadge /> : null}</div>
            <p className="text-xs text-muted-foreground tnum">{[fmtDateTime(e.occurredAt, zoneOfEvent(e), 'dd MMM, HH:mm'), e.roomName, e.deviceName, e.meetingTitle].filter(Boolean).join(' · ')}</p>
          </div>
        )}
      />
    </div>
  );
}
