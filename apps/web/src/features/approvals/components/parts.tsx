import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, CalendarOff, Clock, FileQuestion, MessageSquareText } from 'lucide-react';
import type { ApprovalContextDto, ApprovalEntity, ApprovalRequestDto, ApprovalRequestStatus, ApprovalStepDto } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { fmtDate } from '@/lib/format';
import { CorrectionTypeBadge } from '@/features/attendance/components/badges';
import { CorrectionSummary } from '@/features/attendance/components/record-dialog';
import { modeText } from '../labels';
import { AR_NS } from '@/features/attendance-review/i18n';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { fmtTime } from '@/lib/format';

const STATUS_TONE: Record<string, 'warning' | 'success' | 'danger' | 'neutral'> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral', INVALIDATED: 'neutral', SKIPPED: 'neutral' };

export function RequestStatusBadge({ status }: { status: ApprovalRequestStatus | ApprovalStepDto['status'] }) {
  const { t } = useTranslation('approvals');
  return <Badge variant={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}`, { defaultValue: status })}</Badge>;
}

export function EntityIcon({ entityType, className }: { entityType: ApprovalEntity; className?: string }) {
  const Icon = entityType === 'LEAVE' || entityType === 'COMP_OFF' ? CalendarOff : entityType === 'ATTENDANCE_CORRECTION' || entityType === 'MISSING_PUNCH' || entityType === 'REGULARISATION' ? Clock
    : entityType === 'ATTENDANCE_NOTE' ? MessageSquareText : entityType === 'SHIFT_SWAP' ? ArrowLeftRight : FileQuestion;
  const tone = entityType === 'LEAVE' || entityType === 'COMP_OFF' ? 'bg-chart-leave/12 text-chart-leave' : 'bg-chart-late/12 text-chart-late';
  return <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tone, className)} aria-hidden><Icon className="size-4" /></span>;
}

/** "Level 1 of 2 · any one approves" — the current level of a pending request, or the level count once it is closed. */
export function LevelLabel({ request }: { request: ApprovalRequestDto }) {
  const { t } = useTranslation('approvals');
  const step = request.steps.find((s) => s.stepNo === request.currentStep);
  if (!request.stepCount) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="text-xs">
      <span className="tnum font-medium">{t('level', { n: request.currentStep, count: request.stepCount })}</span>
      {request.status === 'PENDING' && step ? <span className="block text-muted-foreground">{t(`approverType.${step.approverType}`)} · {modeText(t, step)}</span> : null}
    </span>
  );
}

/** What the request is about, per entity type (correction diff, leave range + balance, generic summary). */
export function ApprovalContext({ context, timezone, compact = false }: { context: ApprovalContextDto; timezone: string; compact?: boolean }) {
  const { t } = useTranslation('approvals');
  if (context.kind === 'ATTENDANCE_CORRECTION') {
    const c = context.correction;
    return (
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2"><span className="tnum">{fmtDate(c.attendanceDate)}</span><CorrectionTypeBadge type={c.type} />
          <CorrectionSummary c={{ type: c.type, originalPunchedAt: c.originalPunchedAt, proposedPunchedAt: c.proposedPunchedAt, proposedEventType: c.proposedEventType, proposedStatus: c.proposedStatus } as Parameters<typeof CorrectionSummary>[0]['c']} timezone={timezone} />
        </p>
        {!compact && c.reason ? <p className="text-xs text-muted-foreground">{t('context.reason', { reason: c.reason })}</p> : compact && c.reason ? <p className="max-w-[260px] truncate text-xs text-muted-foreground" title={c.reason}>{c.reason}</p> : null}
      </div>
    );
  }
  if (context.kind === 'LEAVE') {
    const l = context.leave;
    return (
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{l.leaveTypeName}</span>
          <span className="tnum text-xs">{l.startDate === l.endDate ? fmtDate(l.startDate) : `${fmtDate(l.startDate, 'dd MMM')} → ${fmtDate(l.endDate)}`}</span>
          {l.days !== null ? <Badge variant="outline" className="tnum">{t('context.leaveDays', { count: l.days })}</Badge> : null}
          {l.isHalfDay ? <Badge variant="secondary">{t('context.halfDay')}</Badge> : null}
        </p>
        {l.balanceRemainingDays !== null && l.allowanceDays !== null ? <p className="text-xs text-muted-foreground tnum">{t('context.balance', { remaining: Math.max(0, l.balanceRemainingDays - (l.days ?? 0)), allowance: l.allowanceDays })}</p> : null}
        {l.reason ? <p className={cn('text-xs text-muted-foreground', compact && 'max-w-[260px] truncate')} title={l.reason}>{compact ? l.reason : t('context.reason', { reason: l.reason })}</p> : null}
      </div>
    );
  }
  if (context.kind === 'ATTENDANCE_NOTE' || context.kind === 'REGULARISATION' || context.kind === 'SHIFT_SWAP') return <PortalRequestContext context={context} timezone={timezone} compact={compact} />;
  return <p className="text-sm text-muted-foreground">{context.summary ?? t('context.noDetails')}</p>;
}

type PortalContext = Extract<ApprovalContextDto, { kind: 'ATTENDANCE_NOTE' | 'REGULARISATION' | 'SHIFT_SWAP' }>;

/** HR portal Prompt 4 requests: a reason given for a day (with the engine's verdict and the year's excused count), a regularisation, a shift swap. */
function PortalRequestContext({ context, timezone, compact }: { context: PortalContext; timezone: string; compact: boolean }) {
  const { t } = useTranslation(AR_NS);
  const clip = cn('text-xs text-muted-foreground', compact && 'max-w-[260px] truncate');
  if (context.kind === 'ATTENDANCE_NOTE') {
    const n = context.note;
    return (
      <div className="min-w-0 space-y-1 text-sm" data-testid="context-note">
        <p className="flex flex-wrap items-center gap-2"><span className="tnum">{fmtDate(n.attendanceDate)}</span>{n.dayStatus ? <AttendanceStatusBadge status={n.dayStatus} /> : null}<FlagChips flags={n.dayFlags} max={2} size="xs" /><Badge variant="outline">{t(`categories.${n.category}`, { defaultValue: n.category })}</Badge>{n.excusedCountYear > 0 ? <Badge variant="secondary">{t('notes.excusedBadge', { count: n.excusedCountYear })}</Badge> : null}</p>
        <p className={clip} title={n.note} dir="auto">{n.note}</p>
        {n.infoRequestMessage ? <p className={cn(clip, 'text-blue-700 dark:text-blue-300')} title={n.infoRequestMessage}>{t('notes.asked', { question: n.infoRequestMessage })}</p> : null}
      </div>
    );
  }
  if (context.kind === 'REGULARISATION') {
    const r = context.regularisation;
    const tz = r.timezone ?? timezone;
    return (
      <div className="min-w-0 space-y-1 text-sm" data-testid="context-regularisation">
        <p className="flex flex-wrap items-center gap-2"><span className="tnum">{fmtDate(r.attendanceDate)}</span><Badge variant="outline">{t(`approvalContext.regularisationTypes.${r.type}`, { defaultValue: r.type })}</Badge>{r.proposedInAt || r.proposedOutAt ? <span className="text-xs tnum" dir="ltr">{fmtTime(r.proposedInAt, tz)} – {fmtTime(r.proposedOutAt, tz)}</span> : null}</p>
        <p className={clip} title={r.reason} dir="auto">{r.reason}</p>
      </div>
    );
  }
  const w = context.swap;
  return (
    <div className="min-w-0 space-y-1 text-sm" data-testid="context-swap">
      <p className="flex flex-wrap items-center gap-2"><span className="tnum">{fmtDate(w.swapDate)}</span><span>{t('approvalContext.swapBetween', { a: w.requesterName ?? '—', b: w.targetName ?? '—' })}</span></p>
      <p className="text-xs">{w.requesterShiftName ?? '—'} ⇄ {w.targetShiftName ?? '—'}</p>
      <p className={clip} title={w.reason} dir="auto">{w.reason}</p>
    </div>
  );
}
