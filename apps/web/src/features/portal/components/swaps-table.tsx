import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Undo2 } from 'lucide-react';
import type { ShiftSwapDto } from '@flowza/contracts';
import { Button, ConfirmDialog, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { PA_NS } from '../attendance-i18n';
import { useSwapMutations } from '../attendance-api';
import { SwapStatusBadge } from './attendance-badges';

/** The swaps the employee asked for and the ones that name them; a pending swap of their own can be withdrawn. */
export function SwapsTable({ rows }: { rows: ShiftSwapDto[] }) {
  const { t } = useTranslation(PA_NS);
  const { cancel } = useSwapMutations();
  const [withdrawing, setWithdrawing] = useState<ShiftSwapDto | null>(null);
  return (
    <div className="rounded-xl border bg-card shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['date', 'with', 'shifts', 'status', 'decision'] as const).map((c) => <TableHead key={c}>{t(`swap.columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
          <TableBody>
            {rows.map((w) => (
              <TableRow key={w.id} data-testid="swap-row">
                <TableCell className="whitespace-nowrap font-medium tnum">{fmtDate(w.swapDate, 'EEE dd MMM')}</TableCell>
                <TableCell className="text-sm">{w.mine ? t('swap.mine', { name: w.targetName ?? '—' }) : t('swap.theirs', { name: w.requesterName ?? '—' })}</TableCell>
                <TableCell className="text-xs">{w.requesterShift?.name ?? '—'} ⇄ {w.targetShift?.name ?? '—'}</TableCell>
                <TableCell><SwapStatusBadge status={w.status} /></TableCell>
                <TableCell className="max-w-[240px] text-xs"><span className="block truncate" title={w.reason}>{w.reason}</span>{w.decisionNote ? <span className="block truncate text-muted-foreground" title={w.decisionNote}>{w.decisionNote}</span> : null}</TableCell>
                <TableCell className="text-end">{w.mine && w.status === 'pending' ? <Button size="sm" variant="ghost" onClick={() => setWithdrawing(w)}><Undo2 /> {t('swap.withdraw')}</Button> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog open={!!withdrawing} onOpenChange={(o) => !o && setWithdrawing(null)} title={t('swap.withdrawTitle')} description={t('swap.withdrawHint')} confirmLabel={t('swap.withdraw')} destructive loading={cancel.isPending}
        onConfirm={() => { if (!withdrawing) return; cancel.mutate(withdrawing.id, { onSuccess: () => { toast.success(t('swap.withdrawn')); setWithdrawing(null); }, onError: toastError }); }} />
    </div>
  );
}
