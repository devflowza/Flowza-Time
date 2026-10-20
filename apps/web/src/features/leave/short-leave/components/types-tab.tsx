import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock3, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { TimeOffTypeDto } from '@flowza/contracts';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { RowActions, type RowAction } from '@/features/organization/components/row-actions';
import { useTimeOffTypeMutations, useTimeOffTypes } from '../api';
import { SL_NS } from '../i18n';
import { fmtDuration } from '../model';
import { TimeOffTypeDialog } from './type-dialog';

/** The rules of a type in a line of chips: counts as work, no approval, the longest request, the monthly quotas, who, HR only. */
export function TypeRules({ type }: { type: TimeOffTypeDto }) {
  const { t } = useTranslation(SL_NS);
  const bits: string[] = [];
  if (type.countsAsWork) bits.push(t('types.chips.work'));
  if (!type.requiresApproval) bits.push(t('types.chips.noApproval'));
  if (type.maxMinutesPerRequest !== null) bits.push(t('types.chips.max', { value: fmtDuration(type.maxMinutesPerRequest) }));
  if (type.monthlyQuotaMinutes !== null) bits.push(t('types.chips.quotaMinutes', { value: fmtDuration(type.monthlyQuotaMinutes) }));
  if (type.monthlyQuotaCount !== null) bits.push(t('types.chips.quotaCount', { count: type.monthlyQuotaCount }));
  if (type.applicableGender !== 'all') bits.push(t(`genders.${type.applicableGender}`));
  if (!type.portalVisible) bits.push(t('types.chips.hrOnly'));
  return bits.length ? <div className="flex max-w-[360px] flex-wrap gap-1">{bits.map((b) => <Badge key={b} variant="secondary" className="font-normal">{b}</Badge>)}</div> : <span className="text-xs text-muted-foreground">—</span>;
}

/** Leave → Short leave types: the organisation's permission types (leave.view to read, leave.manage to change). */
export function TimeOffTypesTab() {
  const { t } = useTranslation(SL_NS);
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('leave.manage');
  const q = useTimeOffTypes();
  const { update, remove, seed } = useTimeOffTypeMutations();
  const [dialog, setDialog] = useState<{ open: boolean; type: TimeOffTypeDto | null }>({ open: false, type: null });
  const [deleting, setDeleting] = useState<TimeOffTypeDto | null>(null);
  const runSeed = () => seed.mutate(undefined, { onSuccess: (r) => toast.success(t('types.seeded', { count: r.created.length })), onError: toastError });
  const actionsFor = (x: TimeOffTypeDto): RowAction[] => [
    { key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, type: x }) },
    { key: 'toggle', label: x.status === 'active' ? t('types.deactivate') : t('types.activate'), onSelect: () => update.mutate({ id: x.id, input: { status: x.status === 'active' ? 'inactive' : 'active' } }, { onSuccess: () => toast.success(t('types.updated')), onError: toastError }) },
    { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(x) },
  ];
  return (
    <div className="space-y-3" data-testid="short-leave-types">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('types.hint')}</p>
        {canManage ? <div className="flex gap-2"><Button size="sm" variant="outline" onClick={runSeed} loading={seed.isPending}><Sparkles /> {t('types.seed')}</Button><Button size="sm" onClick={() => setDialog({ open: true, type: null })}><Plus /> {t('types.add')}</Button></div> : null}
      </div>
      <div className="rounded-xl border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading ? <TableSkeleton cols={5} rows={3} />
          : !q.data || q.data.length === 0 ? <div className="p-4"><EmptyState icon={Clock3} title={t('types.empty')} description={t('types.emptyHint')} action={canManage ? <Button onClick={runSeed} loading={seed.isPending}><Sparkles /> {t('types.seed')}</Button> : undefined} /></div>
          : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>{tc('common.code')}</TableHead><TableHead>{tc('common.name')}</TableHead><TableHead>{t('fields.category')}</TableHead><TableHead>{t('types.rules')}</TableHead><TableHead>{tc('common.status')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {q.data.map((x) => (
                    <TableRow key={x.id} data-testid={`time-off-type-${x.code}`}>
                      <TableCell className="font-mono text-xs" dir="ltr">{x.code}</TableCell>
                      <TableCell><p className="font-medium">{x.name}</p>{x.nameAr ? <p className="text-xs text-muted-foreground" dir="rtl">{x.nameAr}</p> : null}</TableCell>
                      <TableCell><Badge variant="outline">{t(`categories.${x.category}`)}</Badge></TableCell>
                      <TableCell><TypeRules type={x} /></TableCell>
                      <TableCell><Badge variant={x.status === 'active' ? 'success' : 'neutral'} dot>{t(`types.recordStatus.${x.status}`)}</Badge></TableCell>
                      <TableCell className="text-end">{canManage ? <RowActions actions={actionsFor(x)} /> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
      </div>
      <TimeOffTypeDialog key={`${dialog.open}-${dialog.type?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} type={dialog.type} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('types.deleteTitle', { name: deleting?.name ?? '' })} description={t('types.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: (r) => { toast.success(r.archived ? t('types.archived') : t('types.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
