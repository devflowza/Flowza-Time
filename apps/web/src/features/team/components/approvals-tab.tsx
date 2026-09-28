import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, ClipboardCheck, Eye, MessageCircleQuestion, MessageSquareText, ShieldCheck, X } from 'lucide-react';
import type { ApprovalRequestDto, AttendanceNoteReviewItemDto, AttendanceNoteStatus, NoteReviewDecision } from '@flowza/contracts';
import { Badge, Button, Card, EmptyState, ErrorState, Label, Switch, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtTime } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useApprovalAccess, useApprovalInbox, type DecisionKind } from '@/features/approvals/api';
import { DecisionDialog } from '@/features/approvals/components/decision-dialog';
import { RequestDialog } from '@/features/approvals/components/request-detail';
import { ApprovalContext, EntityIcon, LevelLabel, RequestStatusBadge } from '@/features/approvals/components/parts';
import { AR_NS } from '@/features/attendance-review/i18n';
import { useNotesForReview } from '@/features/attendance-review/api';
import { NoteReviewDialog } from '@/features/attendance-review/components/note-review-dialog';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { TEAM_NS } from '../i18n';
import { TEAM_HISTORY_LIMIT, canActOnNote, canActOnRequest, recentTeamRequests } from '../model';

type Mode = 'mine' | 'team';
const INBOX_PAGE = 50;
const NOTES_PAGE = 25;
const NOTE_TONE: Record<AttendanceNoteStatus, 'warning' | 'info' | 'success' | 'danger'> = { pending: 'warning', info_requested: 'info', approved: 'success', excused: 'success', rejected: 'danger' };

function useTzOf() {
  const tz = useOrgTimezone();
  const branches = useBranchOptions();
  return useMemo(() => (branchId: string | null) => (branchId ? branches.byId.get(branchId)?.timezone : undefined) ?? tz, [branches.byId, tz]);
}

/** One approval request: what it is, whose, its level — and Approve / Reject only when it waits for the caller (B-65). */
function RequestRow({ r, viewOnly, onOpen, onDecide }: { r: ApprovalRequestDto; viewOnly: boolean; onOpen: (id: string) => void; onDecide: (r: ApprovalRequestDto, kind: DecisionKind) => void }) {
  const { t } = useTranslation('approvals');
  const { t: tt } = useTranslation(TEAM_NS);
  const tzOf = useTzOf();
  const tz = useOrgTimezone();
  const act = !viewOnly && canActOnRequest(r);
  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center" data-testid="team-request-row" data-entity={r.entityType}>
      <button type="button" className="flex min-w-0 flex-1 items-start gap-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md" onClick={() => onOpen(r.id)}>
        <EntityIcon entityType={r.entityType} />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block truncate text-sm font-medium">{r.employeeName ?? r.requestedByName ?? '—'} <span className="font-mono text-xs font-normal text-muted-foreground" dir="ltr">{r.employeeNumber}</span></span>
          <span className="block text-xs text-muted-foreground">{t(`entity.${r.entityType}`)} · {fmtDateTime(r.createdAt, tz)}</span>
          <ApprovalContext context={r.context} timezone={tzOf(r.branchId)} compact />
        </span>
      </button>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
        {r.status === 'PENDING' ? <LevelLabel request={r} /> : <RequestStatusBadge status={r.status} />}
        {r.infoRequestedAt && r.status === 'PENDING' ? <Badge variant="warning">{t('inbox.waitingForAnswer')}</Badge> : null}
        {act ? (
          <>
            <Button size="sm" variant="outline" onClick={() => onDecide(r, 'REJECT')}><X /> {t('actions.reject')}</Button>
            <Button size="sm" onClick={() => onDecide(r, 'APPROVE')}><Check /> {t('actions.approve')}</Button>
          </>
        ) : viewOnly ? <Badge variant="outline"><Eye className="size-3" /> {tt('approvals.viewOnly')}</Badge> : null}
      </div>
    </li>
  );
}

/**
 * The reasons of the caller's reports (Prompt 4's review list and dialog): approve / reject with its pay effect / excuse / ask
 * — offered ONLY on the rows waiting for the caller and still pending (B-65); rows seen through HR oversight are marked.
 */
function ReasonsSection() {
  const { t } = useTranslation(TEAM_NS);
  const { t: tr } = useTranslation(AR_NS);
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(1);
  const q = useNotesForReview({ scope: 'mine', page, pageSize: NOTES_PAGE, ...(showAll ? {} : { open: true }) });
  const [deciding, setDeciding] = useState<{ note: AttendanceNoteReviewItemDto; decision: NoteReviewDecision } | null>(null);
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta;
  return (
    <section className="space-y-2" aria-labelledby="team-reasons-title">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="team-reasons-title" className="text-sm font-semibold">{t('approvals.reasons')}</h3>
        <div className="ms-auto flex items-center gap-2"><Switch id="team-reasons-all" checked={showAll} onCheckedChange={(v) => { setShowAll(v); setPage(1); }} /><Label htmlFor="team-reasons-all" className="text-sm">{t('approvals.showAll')}</Label></div>
      </div>
      <p className="text-xs text-muted-foreground">{t('approvals.reasonsHint')}</p>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <TableSkeleton cols={5} rows={3} /> : rows.length === 0 ? (
        <EmptyState icon={MessageSquareText} title={t('approvals.reasonsEmpty')} description={t('approvals.reasonsEmptyHint')} />
      ) : (
        <Card className="divide-y">
          {rows.map((n) => {
            const act = canActOnNote(n);
            return (
              <div key={n.id} className="flex flex-col gap-2 p-3 lg:flex-row lg:items-start" data-testid="team-note-row" data-status={n.status}>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium">{n.employeeName}</span> <span className="font-mono text-xs text-muted-foreground" dir="ltr">{n.employeeNumber}</span>
                    <span className="text-xs text-muted-foreground tnum">· {fmtDate(n.attendanceDate, 'EEE dd MMM')}</span>
                    {n.excusedCountYear > 0 ? <Badge variant="outline" className="text-[10px]" data-testid="excused-count">{tr('notes.excusedBadge', { count: n.excusedCountYear })}</Badge> : null}
                    {n.isOversight ? <Badge variant="warning" className="text-[10px]" data-testid="oversight-chip">{tr('notes.oversightChip')}</Badge> : null}
                  </p>
                  <p className="flex flex-wrap items-center gap-1 text-xs">
                    {n.dayStatus ? <><AttendanceStatusBadge status={n.dayStatus} /><FlagChips flags={n.dayFlags} max={2} size="xs" /></> : <span className="text-muted-foreground">{tr('notes.dayUnknown')}</span>}
                    {n.firstInAt || n.lastOutAt ? <span className="text-muted-foreground tnum" dir="ltr">{fmtTime(n.firstInAt, n.timezone ?? 'UTC')} – {fmtTime(n.lastOutAt, n.timezone ?? 'UTC')}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{tr(`categories.${n.category}`)}</p>
                  <p className="text-sm" dir="auto">{n.note}</p>
                  {n.status === 'info_requested' ? <p className="text-xs text-blue-700 dark:text-blue-300">{n.infoRequestMessage ? tr('notes.asked', { question: n.infoRequestMessage }) : t('approvals.waitingForAnswer')}</p> : null}
                  {n.reviewReason && n.status !== 'pending' && n.status !== 'info_requested' ? <p className="text-xs text-muted-foreground">{n.reviewedByName ? `${n.reviewedByName}: ` : ''}{n.reviewReason}</p> : null}
                </div>
                <div className="flex shrink-0 flex-col items-start gap-1.5 lg:items-end">
                  <Badge variant={NOTE_TONE[n.status]} dot>{tr(`notes.status.${n.status}`)}</Badge>
                  {n.status === 'rejected' && (n.payEffectDays ?? 0) > 0 ? <span className="text-xs text-destructive">{n.lossOfPay ? tr('notes.lop', { days: n.payEffectDays }) : n.deductedLeaveTypeName ? tr('notes.deducted', { days: n.payEffectDays, type: n.deductedLeaveTypeName }) : tr('notes.charged', { days: n.payEffectDays })}</span> : null}
                  {act ? (
                    <span className="inline-flex flex-wrap gap-1 lg:justify-end">
                      <Button size="sm" onClick={() => setDeciding({ note: n, decision: 'approve' })}><Check /> {tr('review.actions.approve')}</Button>
                      <Button size="sm" variant="outline" onClick={() => setDeciding({ note: n, decision: 'excuse' })}><ShieldCheck /> {tr('review.actions.excuse')}</Button>
                      <Button size="sm" variant="outline" onClick={() => setDeciding({ note: n, decision: 'reject' })}><X /> {tr('review.actions.reject')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeciding({ note: n, decision: 'request_info' })}><MessageCircleQuestion /> {tr('review.actions.request_info')}</Button>
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {meta && meta.totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2 px-3 py-2 text-xs">
              <span className="tnum text-muted-foreground">{tr('notes.page', { page: meta.page, pages: meta.totalPages, total: meta.total })}</span>
              <Button size="icon" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={tr('notes.previous')}><ChevronLeft className="rtl:rotate-180" /></Button>
              <Button size="icon" variant="ghost" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} aria-label={tr('notes.next')}><ChevronRight className="rtl:rotate-180" /></Button>
            </div>
          ) : null}
        </Card>
      )}
      {deciding ? <NoteReviewDialog key={`${deciding.note.id}:${deciding.decision}`} note={deciding.note} decision={deciding.decision} onClose={() => setDeciding(null)} /> : null}
    </section>
  );
}

/** The requests waiting for the caller (the inbox's "Mine" queue); reasons are listed with their own actions below. */
function MineRequests({ onOpen, onDecide }: { onOpen: (id: string) => void; onDecide: (r: ApprovalRequestDto, kind: DecisionKind) => void }) {
  const { t } = useTranslation(TEAM_NS);
  const q = useApprovalInbox({ scope: 'mine', view: 'pending', page: 1, pageSize: INBOX_PAGE });
  // an ATTENDANCE_NOTE request is the reason below it: decided there (with excuse / ask), never listed twice
  const rows = (q.data?.data ?? []).filter((r) => r.entityType !== 'ATTENDANCE_NOTE');
  const beyond = Math.max(0, (q.data?.meta.total ?? 0) - (q.data?.data.length ?? 0));
  return (
    <section className="space-y-2" aria-labelledby="team-requests-title">
      <h3 id="team-requests-title" className="text-sm font-semibold">{t('approvals.requests')}</h3>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <TableSkeleton cols={4} rows={3} /> : rows.length === 0 && beyond === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t('approvals.requestsEmpty')} description={t('approvals.requestsEmptyHint')} />
      ) : (
        <Card>
          <ul className="divide-y">{rows.map((r) => <RequestRow key={r.id} r={r} viewOnly={false} onOpen={onOpen} onDecide={onDecide} />)}</ul>
          {beyond > 0 ? <p className="border-t px-3 py-2 text-xs"><Link to="/approvals" className="font-medium text-primary hover:underline">{t('approvals.more', { count: beyond })}</Link></p> : null}
        </Card>
      )}
    </section>
  );
}

/** Finance B-64: the direct reports' recent requests (pending and decided), view only, at most 50. */
function TeamRequests({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation(TEAM_NS);
  const pending = useApprovalInbox({ scope: 'team', view: 'pending', page: 1, pageSize: TEAM_HISTORY_LIMIT });
  const history = useApprovalInbox({ scope: 'team', view: 'history', page: 1, pageSize: TEAM_HISTORY_LIMIT });
  const rows = useMemo(() => recentTeamRequests([pending.data?.data ?? [], history.data?.data ?? []]), [pending.data, history.data]);
  const failed = pending.isError ? pending : history.isError ? history : null;
  return (
    <section className="space-y-2">
      <p className="text-xs text-muted-foreground" role="note">{t('approvals.teamHint', { count: TEAM_HISTORY_LIMIT })}</p>
      {failed ? <ErrorState error={failed.error} onRetry={() => { void pending.refetch(); void history.refetch(); }} /> : pending.isLoading || history.isLoading ? <TableSkeleton cols={4} rows={4} /> : rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t('approvals.teamEmpty')} />
      ) : (
        <Card><ul className="divide-y" data-testid="team-requests-view-only">{rows.map((r) => <RequestRow key={r.id} r={r} viewOnly onOpen={onOpen} onDecide={() => undefined} />)}</ul></Card>
      )}
    </section>
  );
}

/**
 * The manager's approvals (Finance B-63 … B-65): by default what waits for the caller — the inbox's "Mine" queue with the
 * Prompt 2 decision dialog and request panel, and the reports' attendance reasons with Prompt 4's review actions — and a
 * view-only "All my team" toggle.
 */
export function ApprovalsTab() {
  const { t } = useTranslation(TEAM_NS);
  const tzOf = useTzOf();
  const access = useApprovalAccess();
  const [mode, setMode] = useState<Mode>('mine');
  const [openId, setOpenId] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ request: ApprovalRequestDto | null; kind: DecisionKind }>({ request: null, kind: 'APPROVE' });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border bg-card p-0.5 shadow-card" role="group" aria-label={t('tabs.approvals')}>
          {(['mine', 'team'] as const).filter((m) => m === 'mine' || access.team).map((m) => (
            <Button key={m} size="sm" variant={mode === m ? 'default' : 'ghost'} aria-pressed={mode === m} onClick={() => setMode(m)}>{t(`approvals.${m}`)}</Button>
          ))}
        </div>
        <Link to="/approvals" className="ms-auto text-xs font-medium text-primary hover:underline">{t('approvals.openInbox')}</Link>
      </div>
      {mode === 'mine' ? (
        <>
          <MineRequests onOpen={setOpenId} onDecide={(r, kind) => setDecision({ request: r, kind })} />
          <ReasonsSection />
        </>
      ) : <TeamRequests onOpen={setOpenId} />}
      <DecisionDialog key={`${decision.request?.id ?? ''}-${decision.kind}`} request={decision.request} decision={decision.kind} timezone={tzOf(decision.request?.branchId ?? null)} onClose={() => setDecision((d) => ({ ...d, request: null }))} />
      <RequestDialog requestId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
