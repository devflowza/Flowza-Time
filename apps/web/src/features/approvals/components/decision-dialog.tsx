import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import type { ApprovalRequestDto } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useApprovalMutations, type DecisionKind } from '../api';
import { decisionToast, waitingSeats } from '../labels';
import { ApprovalContext, EntityIcon } from './parts';

export type Decision = DecisionKind;

/**
 * Approve / reject the current level of one request. Rejecting requires a comment (the API enforces it too). An override or
 * an escalated approver's decision fills ONE waiting seat: on a level that needs several approvals (ALL / QUORUM) with more
 * than one seat waiting the approver chooses whose ("Deciding for" — the API refuses an unnamed one), otherwise the note
 * names the seat it fills; either way the call names that seat, so what the approver saw is what is decided.
 */
export function DecisionDialog({ request, decision, timezone, onClose }: { request: ApprovalRequestDto | null; decision: Decision; timezone: string; onClose: () => void }) {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const { decide } = useApprovalMutations();
  const [comment, setComment] = useState('');
  const reject = decision === 'REJECT';
  const missing = reject && comment.trim().length === 0;
  const via = request?.abilities.decideVia ?? null;
  const fillsSeat = via === 'override' || via === 'escalated';
  const seats = request && fillsSeat ? waitingSeats(request) : [];
  const mustChoose = fillsSeat && request?.abilities.mustChooseSeat === true;
  const [chosen, setChosen] = useState('');
  const target = mustChoose ? (seats.some((s) => s.userId === chosen) ? chosen : '') : (seats[0]?.userId ?? '');
  const seatMissing = mustChoose && !target;
  const seatName = fillsSeat && !mustChoose ? seats[0]?.userName ?? '—' : null;
  const hint = !fillsSeat ? null
    : mustChoose ? (via === 'override' ? t('decision.overrideChooseHint') : t('decision.escalatedChooseHint'))
    : via === 'override' ? t('decision.overrideHint', { name: seatName }) : t('decision.escalatedHint', { name: seatName });
  const submit = () => {
    if (!request || missing || seatMissing) return;
    decide.mutate({ requestId: request.id, stepNo: request.currentStep, decision, comment: comment.trim() || undefined, ...(fillsSeat && target ? { onBehalfOfUserId: target } : {}) }, {
      onSuccess: (res) => { toast.success(decisionToast(t, res, decision, request.currentStep)); onClose(); },
      onError: toastError,
    });
  };
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{reject ? t('decision.rejectTitle') : t('decision.approveTitle')}</DialogTitle>
          <DialogDescription>{reject ? t('decision.rejectHint') : t('decision.approveHint')}</DialogDescription>
        </DialogHeader>
        {request ? (
          <div className="flex gap-3 rounded-md border bg-muted/30 p-3">
            <EntityIcon entityType={request.entityType} />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{request.employeeName ?? request.requestedByName ?? '—'} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{request.employeeNumber}</span></p>
              <p className="text-xs text-muted-foreground">{t(`entity.${request.entityType}`)} · {t('level', { n: request.currentStep, count: request.stepCount })}</p>
              <ApprovalContext context={request.context} timezone={timezone} />
            </div>
          </div>
        ) : null}
        {hint ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100" role="note" data-testid="decision-seat-hint">{hint}</p> : null}
        {mustChoose ? (
          <FormField label={t('decision.decidingFor')} htmlFor="dec-seat" required>
            <Select value={chosen} onValueChange={setChosen}>
              <SelectTrigger id="dec-seat" aria-invalid={seatMissing || undefined}><SelectValue placeholder={t('decision.decidingForPlaceholder')} /></SelectTrigger>
              <SelectContent>{seats.map((s) => <SelectItem key={s.userId} value={s.userId}>{s.userName ?? s.userId.slice(0, 8)}</SelectItem>)}</SelectContent>
            </Select>
            {seatMissing ? <p className="text-xs text-muted-foreground">{t('decision.decidingForRequired')}</p> : null}
          </FormField>
        ) : null}
        <FormField label={t('decision.comment')} htmlFor="dec-comment" required={reject} optional={!reject}>
          <Textarea id="dec-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={reject ? t('decision.rejectPlaceholder') : t('decision.approvePlaceholder')} aria-invalid={missing || undefined} />
          {missing ? <p className="text-xs text-muted-foreground">{t('decision.commentRequired')}</p> : null}
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant={reject ? 'destructive' : 'default'} disabled={missing || seatMissing} loading={decide.isPending} onClick={submit}>{reject ? <><X /> {t('actions.reject')}</> : <><Check /> {t('actions.approve')}</>}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
