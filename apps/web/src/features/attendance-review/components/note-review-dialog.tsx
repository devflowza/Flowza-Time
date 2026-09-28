import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, MessageCircleQuestion, ShieldCheck, X } from 'lucide-react';
import type { AttendanceNoteReviewItemDto, AttendanceSettings, NoteReviewDecision } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useActiveMembership } from '@/features/me/use-me';
import { toastMutationError } from '@/features/attendance/period-locked';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { AR_NS } from '../i18n';
import { useNoteReview } from '../api';
import { defaultPayEffect, type PayEffect } from '../model';
import { PayEffectChoice } from './pay-effect-choice';

/**
 * Decide one reason: approve (accepted, the day stays as calculated), excuse (no deduction for the day), reject with its pay
 * effect (none / half / full, charged to paid leave first, then loss of pay) or ask the employee for more information. The
 * API re-checks everything: segregation of duties, the reviewer's entitlement (line manager or organisation-wide oversight).
 */
export function NoteReviewDialog({ note, decision, onClose }: { note: AttendanceNoteReviewItemDto | null; decision: NoteReviewDecision; onClose: () => void }) {
  const { t } = useTranslation(AR_NS);
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const review = useNoteReview();
  const unexcused = (useActiveMembership()?.settings.attendance as Partial<AttendanceSettings> | undefined)?.unexcused;
  const [comment, setComment] = useState('');
  const [payEffect, setPayEffect] = useState<PayEffect>(() => (note ? defaultPayEffect(note.dayStatus, note.dayFlags, unexcused) : 0));
  const needsText = decision === 'request_info';
  const missing = needsText && comment.trim().length === 0;

  const submit = () => {
    if (!note || missing) return;
    review.mutate({ id: note.id, input: { decision, ...(comment.trim() ? { reason: comment.trim() } : {}), ...(decision === 'reject' ? { payEffectDays: payEffect } : {}) } }, {
      onSuccess: (res) => {
        toast.success(t(`review.done.${decision}`), res.charge && res.charge.payEffectDays > 0 ? { description: t(`review.charge.${res.charge.outcome}`, { days: res.charge.payEffectDays, type: res.charge.leaveTypeCode ?? '' }) } : undefined);
        onClose();
      },
      onError: (e) => toastMutationError(e, (to) => void navigate(to)),
    });
  };
  const Icon = decision === 'reject' ? X : decision === 'request_info' ? MessageCircleQuestion : decision === 'excuse' ? ShieldCheck : Check;

  return (
    <Dialog open={!!note} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t(`review.titles.${decision}`)}</DialogTitle>
          <DialogDescription>{t(`review.hints.${decision}`)}</DialogDescription>
        </DialogHeader>
        {note ? (
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{note.employeeName} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{note.employeeNumber}</span></p>
            <p className="flex flex-wrap items-center gap-1.5 text-xs"><span className="tnum">{fmtDate(note.attendanceDate, 'EEE dd MMM yyyy')}</span>{note.dayStatus ? <AttendanceStatusBadge status={note.dayStatus} /> : null}<FlagChips flags={note.dayFlags} max={3} size="xs" /></p>
            <p className="text-xs text-muted-foreground">{t(`categories.${note.category}`)}</p>
            <p className="whitespace-pre-wrap" dir="auto">{note.note}</p>
            {note.isOversight ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('review.oversightNote')}</p> : null}
          </div>
        ) : null}
        {decision === 'reject' ? <PayEffectChoice value={payEffect} onChange={setPayEffect} /> : null}
        <FormField label={needsText ? t('review.question') : t('review.comment')} htmlFor="note-review-comment" required={needsText} optional={!needsText}>
          <Textarea id="note-review-comment" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={needsText ? t('review.questionPlaceholder') : t('review.commentPlaceholder')} aria-invalid={missing || undefined} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant={decision === 'reject' ? 'destructive' : 'default'} disabled={missing} loading={review.isPending} onClick={submit}><Icon /> {t(`review.actions.${decision}`)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
