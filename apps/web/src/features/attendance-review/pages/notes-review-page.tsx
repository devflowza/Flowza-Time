import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, MessageCircleQuestion, MessageSquareText, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { NOTE_LIST_SCOPES, type AttendanceNoteReviewItemDto, type AttendanceNoteStatus, type NoteListScope, type NoteReviewDecision } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, EmptyState, ErrorState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { fmtDate, fmtTime } from '@/lib/format';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { AR_NS } from '../i18n';
import { useNotesForReview, useReviewAccess } from '../api';
import { NoteReviewDialog } from '../components/note-review-dialog';
import { SelfieReviewPanel } from '../components/selfie-review';
import { AA_NS } from '@/features/attendance-admin/i18n';
import { NotesReport } from '@/features/attendance-admin/components/notes-report';
import { useModuleEnabled } from '@/features/me/use-me';

// 'report': the comments & approvals report (HR portal Prompt 6b, features/attendance-admin)
const TABS = ['reasons', 'selfies', 'report'] as const;
type Tab = (typeof TABS)[number];
const STATUS_FILTERS = ['open', 'approved', 'excused', 'rejected', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const NOTE_TONE: Record<AttendanceNoteStatus, 'warning' | 'info' | 'success' | 'danger'> = { pending: 'warning', info_requested: 'info', approved: 'success', excused: 'success', rejected: 'danger' };
const PAGE_SIZE = 25;

/**
 * The review actions' column: pinned to the inline end (right in English, left in Arabic) over the columns scrolling beneath.
 * The dividing line is drawn by a pseudo-element: a collapsed table border stays behind when its cell sticks.
 */
const STICKY_END = "sticky end-0 z-10 bg-card before:absolute before:inset-y-0 before:start-0 before:w-px before:bg-border before:content-['']";
const STICKY_END_HEAD = `${STICKY_END} bg-linear-to-r from-muted/50 to-muted/50`;
const STICKY_END_CELL = `${STICKY_END} text-end`;

function ReasonsTab({ scope, status, onScope, onStatus, oversight }: { scope: NoteListScope; status: StatusFilter; onScope: (s: NoteListScope) => void; onStatus: (s: StatusFilter) => void; oversight: boolean }) {
  const { t } = useTranslation(AR_NS);
  const [page, setPage] = useState(1);
  const q = useNotesForReview({ scope, page, pageSize: PAGE_SIZE, ...(status === 'open' ? { open: true } : status === 'all' ? {} : { status }) });
  const [deciding, setDeciding] = useState<{ note: AttendanceNoteReviewItemDto; decision: NoteReviewDecision } | null>(null);
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta;
  const scopes = NOTE_LIST_SCOPES.filter((s) => s !== 'all' || oversight);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border bg-card p-0.5 shadow-card" role="group" aria-label={t('notes.scopeLabel')}>
          {scopes.map((s) => <Button key={s} size="sm" variant={s === scope ? 'default' : 'ghost'} aria-pressed={s === scope} onClick={() => { setPage(1); onScope(s); }}>{t(`notes.scope.${s}`)}</Button>)}
        </div>
        <div className="inline-flex flex-wrap rounded-md border bg-card p-0.5 shadow-card" role="group" aria-label={t('notes.statusLabel')}>
          {STATUS_FILTERS.map((s) => <Button key={s} size="sm" variant={s === status ? 'secondary' : 'ghost'} aria-pressed={s === status} onClick={() => { setPage(1); onStatus(s); }}>{t(`notes.filters.${s}`)}</Button>)}
        </div>
      </div>
      {scope === 'all' ? (
        <div role="note" data-testid="oversight-banner" className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>{t('notes.oversightBanner')}</p>
        </div>
      ) : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <TableSkeleton cols={7} rows={5} /> : rows.length === 0 ? (
        <EmptyState icon={MessageSquareText} title={t('notes.empty')} description={t('notes.emptyHint')} />
      ) : (
        <div className="rounded-lg border bg-card shadow-card">
          <div className="overflow-x-auto">
            <Table>
              {/* the actions column stays at the visible end while the rest scrolls sideways (a narrow screen, a long table) */}
              <TableHeader><TableRow>{(['employee', 'date', 'day', 'reason', 'status'] as const).map((c) => <TableHead key={c}>{t(`notes.columns.${c}`)}</TableHead>)}<TableHead className={STICKY_END_HEAD} /></TableRow></TableHeader>
              <TableBody>
                {rows.map((n) => (
                  <TableRow key={n.id} data-testid="note-review-row">
                    <TableCell className="min-w-[180px]">
                      <span className="block font-medium">{n.employeeName} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{n.employeeNumber}</span></span>
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {n.excusedCountYear > 0 ? <Badge variant="outline" className="text-[10px]" data-testid="excused-count">{t('notes.excusedBadge', { count: n.excusedCountYear })}</Badge> : null}
                        {n.isOversight ? <Badge variant="warning" className="text-[10px]">{t('notes.oversightChip')}</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-medium tnum">{fmtDate(n.attendanceDate, 'EEE dd MMM')}</TableCell>
                    <TableCell className="min-w-[150px]">
                      {n.dayStatus ? <span className="flex flex-wrap items-center gap-1"><AttendanceStatusBadge status={n.dayStatus} /><FlagChips flags={n.dayFlags} max={2} size="xs" /></span> : <span className="text-xs text-muted-foreground">{t('notes.dayUnknown')}</span>}
                      {n.firstInAt || n.lastOutAt ? <span className="mt-0.5 block text-xs text-muted-foreground tnum" dir="ltr">{fmtTime(n.firstInAt, n.timezone ?? 'UTC')} – {fmtTime(n.lastOutAt, n.timezone ?? 'UTC')}</span> : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {/* capped here, not on the cell: a table sizes a column by its content, and a one-line truncation still counts the whole note */}
                      <div className="max-w-[18rem]">
                        <span className="block text-xs text-muted-foreground">{t(`categories.${n.category}`)}</span>
                        <span className="block truncate" title={n.note} dir="auto">{n.note}</span>
                        {n.status === 'info_requested' && n.infoRequestMessage ? <span className="block truncate text-xs text-blue-700 dark:text-blue-300" title={n.infoRequestMessage}>{t('notes.asked', { question: n.infoRequestMessage })}</span> : null}
                        {n.reviewReason && n.status !== 'pending' && n.status !== 'info_requested' ? <span className="block truncate text-xs text-muted-foreground" title={n.reviewReason}>{n.reviewedByName ? `${n.reviewedByName}: ` : ''}{n.reviewReason}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={NOTE_TONE[n.status]} dot>{t(`notes.status.${n.status}`)}</Badge>
                      {n.status === 'rejected' && (n.payEffectDays ?? 0) > 0 ? <span className="block text-xs text-destructive">{n.lossOfPay ? t('notes.lop', { days: n.payEffectDays }) : n.deductedLeaveTypeName ? t('notes.deducted', { days: n.payEffectDays, type: n.deductedLeaveTypeName }) : t('notes.charged', { days: n.payEffectDays })}</span> : null}
                    </TableCell>
                    <TableCell className={STICKY_END_CELL}>
                      {n.canReview ? (
                        <span className="inline-flex flex-wrap justify-end gap-1">
                          <Button size="sm" onClick={() => setDeciding({ note: n, decision: 'approve' })}><Check /> {t('review.actions.approve')}</Button>
                          <Button size="sm" variant="outline" onClick={() => setDeciding({ note: n, decision: 'excuse' })}><ShieldCheck /> {t('review.actions.excuse')}</Button>
                          <Button size="sm" variant="outline" onClick={() => setDeciding({ note: n, decision: 'reject' })}><X /> {t('review.actions.reject')}</Button>
                          {n.status === 'pending' ? <Button size="sm" variant="ghost" onClick={() => setDeciding({ note: n, decision: 'request_info' })}><MessageCircleQuestion /> {t('review.actions.request_info')}</Button> : null}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {meta && meta.totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2 border-t px-3 py-2 text-xs">
              <span className="tnum text-muted-foreground">{t('notes.page', { page: meta.page, pages: meta.totalPages, total: meta.total })}</span>
              <Button size="icon" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('notes.previous')}><ChevronLeft className="rtl:rotate-180" /></Button>
              <Button size="icon" variant="ghost" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} aria-label={t('notes.next')}><ChevronRight className="rtl:rotate-180" /></Button>
            </div>
          ) : null}
        </div>
      )}
      {deciding ? <NoteReviewDialog key={`${deciding.note.id}:${deciding.decision}`} note={deciding.note} decision={deciding.decision} onClose={() => setDeciding(null)} /> : null}
    </div>
  );
}

/**
 * /attendance/notes?tab=reasons|selfies&scope=mine|team|all&status=… — the reasons employees gave for their days and the
 * selfie check-ins waiting for a decision. Line managers review their team's; HR reviews organisation-wide as oversight
 * (flagged as such, and recorded as an override by the approval engine).
 */
export default function NotesReviewPage() {
  const { t } = useTranslation(AR_NS);
  const { t: ta } = useTranslation(AA_NS);
  const reviewAccess = useReviewAccess();
  // selfie check-ins belong to the Web check-in & geofencing module (migration 20260929000600)
  const geofencesOn = useModuleEnabled('geofences');
  const access = { ...reviewAccess, selfies: reviewAccess.selfies && geofencesOn };
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') && (params.get('tab') !== 'selfies' || access.selfies) ? (params.get('tab') as Tab) : 'reasons';
  const scopeParam = params.get('scope');
  // "Organisation" needs the oversight keys; anyone else stays on their own queue
  const scope: NoteListScope = scopeParam === 'team' ? 'team' : scopeParam === 'all' && access.oversight ? 'all' : 'mine';
  const statusParam = params.get('status');
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(statusParam ?? '') ? (statusParam as StatusFilter) : 'open';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k, v); }
    setParams(next, { replace: true });
  };
  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('notes.title')} description={t('notes.subtitle')} actions={<Button asChild variant="outline"><Link to="/approvals">{t('notes.openInbox')}</Link></Button>} />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v })}>
        <TabsList aria-label={t('notes.title')}>{TABS.filter((tb) => tb !== 'selfies' || access.selfies).map((tb) => <TabsTrigger key={tb} value={tb}>{tb === 'report' ? ta('report.tab') : t(`notes.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="reasons">{tab === 'reasons' ? <ReasonsTab scope={scope} status={status} oversight={access.oversight} onScope={(s) => set({ scope: s })} onStatus={(s) => set({ status: s })} /> : null}</TabsContent>
        <TabsContent value="selfies">{tab === 'selfies' ? <SelfieReviewPanel /> : null}</TabsContent>
        <TabsContent value="report">{tab === 'report' ? <NotesReport oversight={access.oversight} /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
