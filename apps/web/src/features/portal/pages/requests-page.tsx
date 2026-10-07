import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { ArrowLeftRight, Camera, ClipboardList, Eye, MessageSquareText, Pencil, Plus, Undo2 } from 'lucide-react';
import type { AttendanceNoteDto, RegularisationDto, SelfieCheckinDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, EmptyState, ErrorState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtTime, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useModuleEnabled, useOrgTimezone } from '@/features/me/use-me';
import { PA_NS } from '../attendance-i18n';
import { useMyNotes, useMyRegularisations, useMySelfiePhoto, useMySelfies, useMySwaps, useRegularisationMutations } from '../attendance-api';
import { fmtDays } from '../model';
import { NoteStatusBadge, RegularisationStatusBadge, SelfieStatusBadge, VerdictChip } from '../components/attendance-badges';
import { SwapsTable } from '../components/swaps-table';
import { NoteDialog } from '../components/note-dialog';
import { RegularisationDialog } from '../components/regularisation-dialog';

const TABS = ['reasons', 'regularisations', 'swaps', 'selfies'] as const;
type Tab = (typeof TABS)[number];

/** The pay effect a rejected reason carried (charged to a leave type, or unpaid). */
function NoteOutcome({ n }: { n: AttendanceNoteDto }) {
  const { t } = useTranslation(PA_NS);
  if (n.status === 'rejected' && (n.payEffectDays ?? 0) > 0) {
    return <span className="block text-xs text-destructive">{n.lossOfPay ? t('notes.lop', { days: fmtDays(n.payEffectDays ?? 0) }) : n.deductedLeaveTypeName ? t('notes.deducted', { days: fmtDays(n.payEffectDays ?? 0), type: n.deductedLeaveTypeName }) : t('notes.charged', { days: fmtDays(n.payEffectDays ?? 0) })}</span>;
  }
  return null;
}

function ReasonsTab({ onEdit }: { onEdit: (n: AttendanceNoteDto) => void }) {
  const { t } = useTranslation(PA_NS);
  const q = useMyNotes();
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <TableSkeleton cols={5} rows={3} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <EmptyState icon={MessageSquareText} title={t('notes.empty')} description={t('notes.emptyHint')} />;
  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['date', 'type', 'details', 'status', 'decision'] as const).map((c) => <TableHead key={c}>{t(`requests.columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
          <TableBody>
            {rows.map((n) => (
              <TableRow key={n.id} data-testid="note-row">
                <TableCell className="whitespace-nowrap font-medium tnum">{fmtDate(n.attendanceDate, 'EEE dd MMM')}</TableCell>
                <TableCell className="text-xs">{t(`notes.categories.${n.category}`)}</TableCell>
                <TableCell className="max-w-[320px] text-xs"><span className="block truncate" title={n.note}>{n.note}</span>{n.status === 'info_requested' && n.infoRequestMessage ? <span className="block truncate text-blue-700 dark:text-blue-300" title={n.infoRequestMessage}>{t('notes.question', { question: n.infoRequestMessage })}</span> : null}</TableCell>
                <TableCell><NoteStatusBadge status={n.status} /></TableCell>
                <TableCell className="max-w-[240px] text-xs">{n.reviewedByName ? <span className="block">{t('notes.reviewedBy', { name: n.reviewedByName })}</span> : null}{n.reviewReason ? <span className="block truncate text-muted-foreground" title={n.reviewReason}>{n.reviewReason}</span> : null}<NoteOutcome n={n} /></TableCell>
                <TableCell className="text-end">
                  {n.status === 'info_requested' ? <Button size="sm" onClick={() => onEdit(n)}><MessageSquareText /> {t('notes.respond')}</Button>
                    : n.status === 'pending' ? <Button size="sm" variant="ghost" onClick={() => onEdit(n)}><Pencil /> {t('notes.edit')}</Button> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RegularisationsTab({ timezone }: { timezone: string }) {
  const { t } = useTranslation(PA_NS);
  const q = useMyRegularisations();
  const { cancel } = useRegularisationMutations();
  const [withdrawing, setWithdrawing] = useState<RegularisationDto | null>(null);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <TableSkeleton cols={5} rows={3} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <EmptyState icon={ClipboardList} title={t('regularisation.empty')} description={t('regularisation.emptyHint')} />;
  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['date', 'type', 'details', 'status', 'decision'] as const).map((c) => <TableHead key={c}>{t(`requests.columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} data-testid="regularisation-row">
                <TableCell className="whitespace-nowrap font-medium tnum">{fmtDate(r.attendanceDate, 'EEE dd MMM')}</TableCell>
                <TableCell className="text-xs">{t(`regularisation.types.${r.type}`)}</TableCell>
                <TableCell className="max-w-[320px] text-xs">
                  {r.proposedInAt || r.proposedOutAt ? <span className="block tnum" dir="ltr">{fmtTime(r.proposedInAt, timezone)} – {fmtTime(r.proposedOutAt, timezone)}</span> : null}
                  <span className="block truncate text-muted-foreground" title={r.reason}>{r.reason}</span>
                </TableCell>
                <TableCell><RegularisationStatusBadge status={r.status} />{r.status === 'pending' && r.approvalStepCount ? <span className="ms-1 text-xs text-muted-foreground tnum">{t('requests.level', { n: r.approvalCurrentStep ?? 1, count: r.approvalStepCount })}</span> : null}</TableCell>
                <TableCell className="max-w-[240px] text-xs">{r.decidedByName ? <span className="block">{t('notes.reviewedBy', { name: r.decidedByName })}</span> : null}{r.decisionNote ? <span className="block truncate text-muted-foreground" title={r.decisionNote}>{r.decisionNote}</span> : null}{r.appliedAt ? <Badge variant="success" className="mt-1">{t('regularisation.applied')}</Badge> : null}</TableCell>
                <TableCell className="text-end">{r.status === 'pending' ? <Button size="sm" variant="ghost" onClick={() => setWithdrawing(r)}><Undo2 /> {t('regularisation.withdraw')}</Button> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog open={!!withdrawing} onOpenChange={(o) => !o && setWithdrawing(null)} title={t('regularisation.withdrawTitle')} description={t('regularisation.withdrawHint')} confirmLabel={t('regularisation.withdraw')} destructive loading={cancel.isPending}
        onConfirm={() => { if (!withdrawing) return; cancel.mutate(withdrawing.id, { onSuccess: () => { toast.success(t('regularisation.withdrawn')); setWithdrawing(null); }, onError: toastError }); }} />
    </div>
  );
}

function SwapsTab() {
  const { t } = useTranslation(PA_NS);
  const q = useMySwaps();
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <TableSkeleton cols={5} rows={3} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <EmptyState icon={ArrowLeftRight} title={t('swap.empty')} description={t('swap.emptyHint')} />;
  return <SwapsTable rows={rows} />;
}

/** One of the employee's own selfie photos: the API issues a 60-second signed URL when the dialog opens (and records it). */
function MySelfiePhotoDialog({ selfie, onClose, timezone }: { selfie: SelfieCheckinDto | null; onClose: () => void; timezone: string }) {
  const { t } = useTranslation(PA_NS);
  const photo = useMySelfiePhoto(selfie?.id ?? null);
  return (
    <Dialog open={!!selfie} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('selfies.photoTitle')}</DialogTitle>
          <DialogDescription>{selfie ? fmtDateTime(selfie.punchedAt, timezone) : ''}</DialogDescription>
        </DialogHeader>
        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-muted" data-testid="my-selfie-photo">
          {photo.isLoading ? <Skeleton className="size-full" /> : photo.isError ? <p className="p-4 text-center text-sm text-muted-foreground">{t('selfies.photoUnavailable')}</p> : photo.data ? <img src={photo.data.url} alt={t('selfies.photoAlt')} className="size-full object-cover" /> : null}
        </div>
        <p className="text-xs text-muted-foreground">{t('selfies.photoHint')}</p>
      </DialogContent>
    </Dialog>
  );
}

function SelfiesTab({ timezone }: { timezone: string }) {
  const { t } = useTranslation(PA_NS);
  const q = useMySelfies();
  const [viewing, setViewing] = useState<SelfieCheckinDto | null>(null);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <TableSkeleton cols={4} rows={3} />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <EmptyState icon={Camera} title={t('selfies.empty')} description={t('selfies.emptyHint')} />;
  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>{(['submitted', 'type', 'details', 'status', 'decision'] as const).map((c) => <TableHead key={c}>{t(`requests.columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id} data-testid="selfie-row">
                <TableCell className="whitespace-nowrap font-medium tnum">{fmtDateTime(s.punchedAt, timezone, 'EEE dd MMM HH:mm')}</TableCell>
                <TableCell className="text-xs">{t(`checkin.direction.${s.direction}`)}</TableCell>
                <TableCell><VerdictChip verdict={s.verdict} /></TableCell>
                <TableCell><SelfieStatusBadge status={s.status} /></TableCell>
                <TableCell className="max-w-[240px] text-xs">{s.reviewedByName ? <span className="block">{t('notes.reviewedBy', { name: s.reviewedByName })}</span> : null}{s.reviewReason ? <span className="block truncate text-muted-foreground" title={s.reviewReason}>{s.reviewReason}</span> : null}</TableCell>
                <TableCell className="text-end">{s.canViewPhoto !== false ? <Button size="sm" variant="ghost" onClick={() => setViewing(s)}><Eye /> {t('selfies.viewPhoto')}</Button> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {viewing ? <MySelfiePhotoDialog selfie={viewing} onClose={() => setViewing(null)} timezone={timezone} /> : null}
    </div>
  );
}

/** /my/requests?tab=reasons|regularisations|swaps|selfies — what the employee asked for and the decisions on it. */
export default function MyRequestsPage() {
  const { t } = useTranslation(PA_NS);
  const tz = useOrgTimezone();
  const today = todayIso(tz);
  const [params, setParams] = useSearchParams();
  // shift swaps are an Enterprise feature (module shift_requests): without it the tab is not offered (no 403 from the page)
  const swapsOn = useModuleEnabled('shift_requests');
  const tabs = TABS.filter((tb) => tb !== 'swaps' || swapsOn);
  const tab: Tab = (tabs as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'reasons';
  const [editing, setEditing] = useState<AttendanceNoteDto | null>(null);
  const [newNote, setNewNote] = useState(false);
  const [newRegularisation, setNewRegularisation] = useState(false);

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('requests.title')} description={t('requests.subtitle')}
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setNewNote(true)}><MessageSquareText /> {t('notes.add')}</Button>
          <Button onClick={() => setNewRegularisation(true)}><Plus /> {t('regularisation.new')}</Button>
        </div>} />
      <Tabs value={tab} onValueChange={(v) => { const next = new URLSearchParams(params); next.set('tab', v); setParams(next, { replace: true }); }}>
        <TabsList aria-label={t('requests.title')} className="max-w-full overflow-x-auto">{tabs.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`requests.tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="reasons">{tab === 'reasons' ? <ReasonsTab onEdit={setEditing} /> : null}</TabsContent>
        <TabsContent value="regularisations">{tab === 'regularisations' ? <RegularisationsTab timezone={tz} /> : null}</TabsContent>
        <TabsContent value="swaps">{tab === 'swaps' ? <SwapsTab /> : null}</TabsContent>
        <TabsContent value="selfies">{tab === 'selfies' ? <SelfiesTab timezone={tz} /> : null}</TabsContent>
      </Tabs>
      {editing ? <NoteDialog key={editing.id} open onOpenChange={(o) => !o && setEditing(null)} note={editing} /> : null}
      {/* a reason may be given ahead of a planned day (client visit, field work) — up to 30 days, like the API allows */}
      {newNote ? <NoteDialog open onOpenChange={setNewNote} maxDate={DateTime.fromISO(today).plus({ days: 30 }).toISODate() ?? today} /> : null}
      {newRegularisation ? <RegularisationDialog open onOpenChange={setNewRegularisation} timezone={tz} maxDate={today} /> : null}
    </div>
  );
}
