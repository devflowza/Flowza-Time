import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Undo2 } from 'lucide-react';
import type { ShiftChangeRequestDto } from '@flowza/contracts';
import { Button, ConfirmDialog, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { SR_NS } from '../i18n';
import { useShiftChangeMutations } from '../api';
import { RangeText, ShiftChangeKindBadge, ShiftChangeStatusBadge, ShiftsText } from './parts';

/** The employee's own shift change requests (portal, My shift); a pending one can be withdrawn. */
export function ShiftChangesTable({ rows }: { rows: ShiftChangeRequestDto[] }) {
  const { t } = useTranslation(SR_NS);
  const { cancel } = useShiftChangeMutations();
  const [withdrawing, setWithdrawing] = useState<ShiftChangeRequestDto | null>(null);
  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['dates', 'kind', 'shifts', 'status', 'decision'] as const).map((c) => <TableHead key={c}>{t(`columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} data-testid="shift-change-row">
                <TableCell className="font-medium"><RangeText from={r.fromDate} to={r.toDate} /></TableCell>
                <TableCell><ShiftChangeKindBadge kind={r.kind} /></TableCell>
                <TableCell className="text-xs"><ShiftsText r={r} /></TableCell>
                <TableCell><ShiftChangeStatusBadge status={r.status} /></TableCell>
                <TableCell className="max-w-[240px] text-xs"><span className="block truncate" title={r.reason} dir="auto">{r.reason}</span>{r.decisionNote ? <span className="block truncate text-muted-foreground" title={r.decisionNote} dir="auto">{r.decisionNote}</span> : null}</TableCell>
                <TableCell className="text-end">{r.mine && r.status === 'pending' ? <Button size="sm" variant="ghost" onClick={() => setWithdrawing(r)}><Undo2 /> {t('withdraw')}</Button> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog open={!!withdrawing} onOpenChange={(o) => !o && setWithdrawing(null)} title={t('withdrawTitle')} description={t('withdrawHint')} confirmLabel={t('withdraw')} destructive loading={cancel.isPending}
        onConfirm={() => { if (!withdrawing) return; cancel.mutate(withdrawing.id, { onSuccess: () => { toast.success(t('withdrawn')); setWithdrawing(null); }, onError: toastError }); }} />
    </div>
  );
}
