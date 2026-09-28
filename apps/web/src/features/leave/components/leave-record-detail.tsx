import { useTranslation } from 'react-i18next';
import { GitCommitVertical } from 'lucide-react';
import { Badge, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { RequestDetail } from '@/features/approvals/components/request-detail';
import type { LeaveRecordDto } from '../types';
import { fmtLeaveDays } from '../model';
import { LeaveStatusBadge, LeaveTypeDot } from './leave-status';
import { LeaveThread } from './leave-thread';

/** Range with the half-day part, e.g. "04 Oct → 08 Oct 2026" or "04 Oct 2026 · First half". */
export function LeaveRange({ r }: { r: Pick<LeaveRecordDto, 'startDate' | 'endDate' | 'isHalfDay' | 'halfDayPart'> }) {
  const { t } = useTranslation('leave');
  return (
    <span className="whitespace-nowrap tnum">
      {r.startDate === r.endDate ? fmtDate(r.startDate) : `${fmtDate(r.startDate, 'dd MMM')} → ${fmtDate(r.endDate)}`}
      {r.isHalfDay ? <Badge variant="outline" className="ms-2">{r.halfDayPart ? t(`halfDayParts.${r.halfDayPart}`, { defaultValue: r.halfDayPart }) : t('fields.halfDay')}</Badge> : null}
    </span>
  );
}

/**
 * A leave request on the HR Leave page: what was asked, the conversation with the employee, and — for requests routed by the
 * approval engine — the levels, the timeline and the approver's actions (the engine's own detail; decisions go through it).
 */
export function LeaveRecordDetailDialog({ record, onClose }: { record: LeaveRecordDto | null; onClose: () => void }) {
  const { t } = useTranslation('leave');
  const tz = useOrgTimezone();
  const r = record;
  return (
    <Dialog open={!!r} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('detail.title')}</DialogTitle>
          <DialogDescription>{r ? `${r.employeeName ?? ''}${r.employeeNumber ? ` · ${r.employeeNumber}` : ''}` : null}</DialogDescription>
        </DialogHeader>
        {r ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 font-medium"><LeaveTypeDot color={r.color} />{r.leaveTypeName ?? '—'}{r.compOff ? <Badge variant="info">{t('compOff.badge')}</Badge> : null}</p>
                <p className="text-xs"><LeaveRange r={r} />{r.days !== null && r.days !== undefined ? <span className="ms-2 text-muted-foreground">· {t('detail.days', { count: r.days, days: fmtLeaveDays(r.days) })}</span> : null}</p>
                {r.reason ? <p className="text-xs"><span className="font-medium">{t('fields.reason')}:</span> <span dir="auto">{r.reason}</span></p> : null}
                {r.decisionNote ? <p className="text-xs text-muted-foreground">{t('decision.noteShort', { note: r.decisionNote })}</p> : null}
                <p className="text-xs text-muted-foreground">{t('detail.created', { when: fmtDateTime(r.createdAt, tz) })}{r.editedAt ? ` · ${t('detail.edited', { when: fmtDateTime(r.editedAt, tz) })}` : ''}{r.withdrawnAt ? ` · ${t('detail.withdrawn', { when: fmtDateTime(r.withdrawnAt, tz) })}` : ''}</p>
              </div>
              <LeaveStatusBadge status={r.status} />
            </div>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <LeaveThread leaveId={r.id} />
              <section className="space-y-2">
                <h4 className="flex items-center gap-2 text-sm font-semibold"><GitCommitVertical className="size-4" aria-hidden /> {t('detail.approval')}</h4>
                {r.approvalRequestId ? <RequestDetail requestId={r.approvalRequestId} /> : <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t('detail.noRequest')}</p>}
              </section>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
