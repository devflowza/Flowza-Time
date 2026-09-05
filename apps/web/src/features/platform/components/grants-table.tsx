import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import type { AccessGrantDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Checkbox, ConfirmDialog } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useAccessGrants, usePlatformMutations } from '../api';

/** Support access grants (all organisations, or one when `organizationId` is given) with revoke. */
export function GrantsTable({ organizationId }: { organizationId?: string }) {
  const { t } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [activeOnly, setActiveOnly] = useState(true);
  const q = useAccessGrants(useMemo(() => ({ page, pageSize, organizationId, activeOnly }), [page, pageSize, organizationId, activeOnly]));
  const { revokeGrant } = usePlatformMutations();
  const [revoking, setRevoking] = useState<AccessGrantDto | null>(null);
  const columns = useMemo<ColumnDef<AccessGrantDto, unknown>[]>(() => [
    ...(organizationId ? [] : [{ id: 'org', header: t('grants.organization'), cell: ({ row }) => row.original.organizationName ?? row.original.organizationId.slice(0, 8) } as ColumnDef<AccessGrantDto, unknown>]),
    { id: 'admin', header: t('grants.admin'), cell: ({ row }) => <span dir="ltr" className="text-xs">{row.original.platformAdminEmail ?? row.original.platformAdminUserId.slice(0, 8)}</span> },
    { id: 'level', header: t('grants.level'), cell: ({ row }) => <Badge variant={row.original.accessLevel === 'write' ? 'warning' : 'info'}>{t(`grants.levels.${row.original.accessLevel}`)}</Badge> },
    { id: 'reason', header: t('grants.reason'), cell: ({ row }) => <span className="block max-w-[320px] truncate text-sm" title={row.original.reason}>{row.original.reason}{row.original.ticketRef ? <span className="ms-1 font-mono text-xs text-muted-foreground" dir="ltr">#{row.original.ticketRef}</span> : null}</span> },
    { id: 'window', header: t('grants.window'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.startsAt, 'UTC', 'dd MMM HH:mm')} → {fmtDateTime(row.original.expiresAt, 'UTC', 'dd MMM HH:mm')} UTC</span> },
    { id: 'state', header: tc('common.status'), cell: ({ row }) => row.original.revokedAt ? <Badge variant="neutral">{t('grants.revoked')}</Badge> : row.original.active ? <Badge variant="success" dot>{t('grants.active')}</Badge> : <Badge variant="neutral">{t('grants.expired')}</Badge> },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => row.original.active ? <Button size="sm" variant="outline" className="text-destructive" onClick={(e) => { e.stopPropagation(); setRevoking(row.original); }}>{t('grants.revoke')}</Button> : null },
  ], [t, tc, organizationId]);
  return (
    <>
      <DataTable columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} emptyTitle={t('grants.empty')} emptyDescription={t('grants.emptyHint')}
        toolbar={<label className="flex items-center gap-2 text-sm"><Checkbox checked={activeOnly} onCheckedChange={(v) => { setActiveOnly(!!v); setPage(1); }} /> <span>{t('grants.activeOnly')}</span></label>} />
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={t('grants.revokeTitle')} description={t('grants.revokeHint')} confirmLabel={t('grants.revoke')} destructive loading={revokeGrant.isPending}
        onConfirm={() => { if (!revoking) return; revokeGrant.mutate(revoking.id, { onSuccess: () => { toast.success(t('grants.revoked')); setRevoking(null); }, onError: toastError }); }} />
    </>
  );
}

