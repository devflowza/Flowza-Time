import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan } from '@/features/me/use-me';
import { usePatternMutations, usePatterns, useShiftOptions } from '../../api';
import type { ShiftPatternDto } from '../../types';
import { PatternDialog } from '../pattern-dialog';

export function PatternsTab() {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('shift.manage');
  const q = usePatterns();
  const shifts = useShiftOptions(true);
  const { remove } = usePatternMutations();
  const [dialog, setDialog] = useState<{ open: boolean; pattern: ShiftPatternDto | null }>({ open: false, pattern: null });
  const [deleting, setDeleting] = useState<ShiftPatternDto | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('patterns.hint')}</p>
        {canManage ? <Button size="sm" onClick={() => setDialog({ open: true, pattern: null })}><Plus /> {t('patterns.add')}</Button> : null}
      </div>
      {q.isLoading ? <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-36 w-full" />)}</div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : !q.data || q.data.length === 0 ? <EmptyState icon={Repeat} title={t('patterns.empty')} description={t('patterns.emptyHint')} action={canManage ? <Button onClick={() => setDialog({ open: true, pattern: null })}><Plus /> {t('patterns.add')}</Button> : undefined} />
        : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {q.data.map((p) => (
              <Card key={p.id}>
                <CardHeader className="flex-row items-start justify-between gap-2">
                  <div className="min-w-0"><CardTitle className="truncate">{p.name} <span className="font-mono text-xs font-normal text-muted-foreground" dir="ltr">{p.code}</span></CardTitle><CardDescription>{t('patterns.cycleDays', { count: p.cycleLengthDays })} · {t('patterns.anchoredOn', { date: fmtDate(p.anchorDate) })}</CardDescription></div>
                  {canManage ? <div className="flex shrink-0 gap-1"><Button variant="ghost" size="icon" className="size-8" aria-label={tc('common.edit')} onClick={() => setDialog({ open: true, pattern: p })}><Pencil /></Button><Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label={tc('common.delete')} onClick={() => setDeleting(p)}><Trash2 /></Button></div> : null}
                </CardHeader>
                <CardContent>
                  <ol className="flex flex-wrap gap-1" aria-label={t('patterns.sequence')}>
                    {Array.from({ length: p.cycleLengthDays }, (_, d) => {
                      const e = p.sequence.find((x) => x.day === d);
                      const shift = e && 'shiftId' in e ? shifts.byId.get(e.shiftId) : undefined;
                      const off = !e || 'off' in e;
                      return <li key={d} title={`${t('patterns.day', { n: d + 1 })}: ${off ? t('patterns.off') : shift?.name ?? '?'}`} className={cn('flex h-7 min-w-7 items-center justify-center rounded px-1 text-[11px] font-semibold tnum', off ? 'bg-muted text-muted-foreground' : 'text-white')} style={off ? undefined : { backgroundColor: shift?.color ?? '#475467' }}>{off ? '·' : shift?.code.slice(0, 3) ?? '?'}</li>;
                    })}
                  </ol>
                  {p.status !== 'active' ? <Badge variant="neutral" className="mt-2">{t(`recordStatus.${p.status}`, { defaultValue: p.status })}</Badge> : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      <PatternDialog key={`${dialog.open}-${dialog.pattern?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} pattern={dialog.pattern} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('patterns.deleteTitle', { name: deleting?.name ?? '' })} description={t('patterns.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('patterns.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
