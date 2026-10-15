import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Lock, Pencil, Plus } from 'lucide-react';
import type { MeetingRoomDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button } from '@/components/ui';
import { useCan } from '@/features/me/use-me';
import { RowActions } from '@/features/organization/components/row-actions';
import { useMeetingRooms } from '../api';
import { MEETINGS_NS } from '../i18n';
import { ReaderDots } from './badges';
import { RoomDialog } from './room-dialog';

/**
 * The meeting rooms: where each is in the location tree, its capacity, whether entry is restricted, its readers (the ACCESS
 * terminals in its place, with their connection) and how many meetings it holds today. meeting.rooms holders create and edit
 * them. The list is small and arrives whole, so it pages on the client.
 */
export function RoomsTab() {
  const { t } = useTranslation(MEETINGS_NS);
  const can = useCan();
  const canEdit = can('meeting.rooms');
  const q = useMeetingRooms();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [dialog, setDialog] = useState<{ open: boolean; room: MeetingRoomDto | null }>({ open: false, room: null });
  const rows = q.data;
  const pageRows = useMemo(() => rows?.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize]);

  const columns = useMemo<ColumnDef<MeetingRoomDto, unknown>[]>(() => [
    { id: 'name', header: t('rooms.columns.name'), cell: ({ row }) => (
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.original.name}</span>
        {row.original.status === 'inactive' ? <Badge variant="neutral">{t('rooms.statuses.inactive')}</Badge> : null}
      </div>
    ) },
    { id: 'location', header: t('rooms.columns.location'), cell: ({ row }) => <span className="text-sm">{row.original.locationName ?? '—'}</span> },
    { id: 'branch', header: t('rooms.columns.branch'), cell: ({ row }) => row.original.branchName ?? '—' },
    { id: 'capacity', header: t('rooms.columns.capacity'), cell: ({ row }) => <span className="tnum">{row.original.capacity ?? <span className="text-muted-foreground">{t('rooms.noLimit')}</span>}</span> },
    { id: 'access', header: t('rooms.columns.access'), cell: ({ row }) => (row.original.restricted ? <Badge variant="warning"><Lock className="size-3" aria-hidden />{t('rooms.restricted')}</Badge> : <Badge variant="outline" className="font-normal">{t('rooms.open')}</Badge>) },
    { id: 'readers', header: t('rooms.columns.readers'), cell: ({ row }) => <ReaderDots readers={row.original.readers} /> },
    { id: 'today', header: t('rooms.columns.today'), cell: ({ row }) => <span className="tnum">{row.original.meetingsToday}</span> },
    ...(canEdit ? [{ id: 'actions', header: '', enableHiding: false, cell: ({ row }) => <RowActions actions={[{ key: 'edit', label: t('rooms.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, room: row.original }) }]} /> } satisfies ColumnDef<MeetingRoomDto, unknown>] : []),
  ], [t, canEdit]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('rooms.hint')}</p>
        {canEdit ? <Button size="sm" onClick={() => setDialog({ open: true, room: null })}><Plus /> {t('rooms.add')}</Button> : null}
      </div>
      <DataTable
        columns={columns} data={pageRows} total={rows?.length} page={page} pageSize={pageSize}
        onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
        isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        onRowClick={canEdit ? (r) => setDialog({ open: true, room: r }) : undefined}
        emptyTitle={t('rooms.empty')} emptyDescription={t('rooms.emptyHint')}
        emptyAction={canEdit ? <Button onClick={() => setDialog({ open: true, room: null })}><Plus /> {t('rooms.add')}</Button> : undefined}
        renderCard={(r) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{r.name}</span>
              {r.restricted ? <Badge variant="warning"><Lock className="size-3" aria-hidden />{t('rooms.restricted')}</Badge> : null}
            </div>
            <p className="text-xs text-muted-foreground tnum">{t('rooms.card', { location: [r.branchName, r.locationName].filter(Boolean).join(' › ') || '—', capacity: r.capacity ?? '—', today: r.meetingsToday })}</p>
            <ReaderDots readers={r.readers} />
          </div>
        )}
      />
      {dialog.open ? <RoomDialog key={dialog.room?.id ?? 'new'} open onOpenChange={(o) => !o && setDialog({ open: false, room: null })} room={dialog.room} /> : null}
    </div>
  );
}
