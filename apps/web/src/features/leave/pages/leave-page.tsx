import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Ban, CalendarOff, Check, MessageSquare, Pencil, Plus, Trash2, X } from 'lucide-react';
import { LEAVE_STATUSES } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Tabs, TabsContent, TabsList, TabsTrigger, Textarea } from '@/components/ui';
import { Combobox, DateRange } from '@/components/forms';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { RowActions, type RowAction } from '@/features/organization/components/row-actions';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useEmployeeOptions } from '@/features/employees/api';
import { toastJobQueued } from '@/features/employees/job-toast';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useApprovalRequest } from '@/features/approvals/api';
import { waitingSeats } from '@/features/approvals/labels';
import { useLeaveMutations, useLeaveRecords, useLeaveTypeOptions, useLeaveTypes } from '../api';
import type { LeaveRecordDto, LeaveTypeDto, WithRecalc } from '../types';
import { decisionOutcome, fmtLeaveDays, UNDECIDED_LEAVE_STATUSES } from '../model';
import { LeaveRecordDialog } from '../components/leave-record-dialog';
import { LeaveTypeDialog } from '../components/leave-type-dialog';
import { LeaveRecordDetailDialog, LeaveRange } from '../components/leave-record-detail';
import { LeaveStatusBadge, LeaveTypeDot } from '../components/leave-status';
import { BalancesTab } from './balances-tab';
import { AllocationsTab } from './allocations-tab';
import { LeaveCalendarTab } from './calendar-tab';

const ALL = '__all__';
const TABS = ['records', 'calendar', 'balances', 'allocations', 'types'] as const;
type Tab = (typeof TABS)[number];

type Decision = { record: LeaveRecordDto; status: 'APPROVED' | 'REJECTED' };

/** The level a pending request waits at, e.g. "Level 2 of 3 · Fatma, Mansoor". */
function ApprovalCell({ r }: { r: LeaveRecordDto }) {
  const { t } = useTranslation('leave');
  if (!r.approvalRequestId || r.approvalStatus !== 'PENDING' || !r.approvalStepCount) return <span className="text-xs text-muted-foreground">—</span>;
  const waiting = r.approvalWaitingFor ?? [];
  return (
    <span className="block max-w-[200px] text-xs">
      <span className="tnum font-medium">{t('records.level', { n: r.approvalCurrentStep ?? 1, count: r.approvalStepCount })}</span>
      {waiting.length ? <span className="block truncate text-muted-foreground" title={waiting.join(', ')}>{t('records.waitingFor', { names: waiting.join(', ') })}</span> : null}
    </span>
  );
}

/**
 * Approve or reject an undecided request (the note is shown to the employee). A decision names the approval level the
 * user saw (`stepNo`, P1-2): the API refuses it if the request has moved on, and never settles another level on the
 * user's behalf. The toast says what actually happened (P2-9): the leave approved, or only its level. An organisation-wide
 * override on a level that waits for several approvers (ALL / QUORUM) fills ONE seat and must say whose (engine §9.8,
 * leave v2 review): the request's abilities say so (`mustChooseSeat`), and a "Deciding for" select names the seat.
 */
function DecisionDialog({ decision, onClose }: { decision: Decision | null; onClose: () => void }) {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const { updateRecord } = useLeaveMutations();
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState('');
  const r = decision?.record;
  const approve = decision?.status === 'APPROVED';
  // the approval engine requires a reason for a rejection (the employee reads it)
  const missing = !approve && note.trim().length === 0;
  const stepNo = r && r.approvalRequestId && r.approvalStatus === 'PENDING' && r.approvalCurrentStep ? r.approvalCurrentStep : null;
  const request = useApprovalRequest(stepNo !== null && r?.approvalRequestId ? r.approvalRequestId : null).data ?? null;
  const fillsSeat = request?.abilities.decideVia === 'override' || request?.abilities.decideVia === 'escalated';
  const mustChoose = !!request && fillsSeat && request.abilities.mustChooseSeat === true && request.currentStep === stepNo;
  const seats = mustChoose && request ? waitingSeats(request) : [];
  const target = seats.some((s) => s.userId === chosen) ? chosen : '';
  const seatMissing = mustChoose && !target;
  const announce = (res: WithRecalc<LeaveRecordDto>, sent: 'APPROVED' | 'REJECTED') => {
    const out = decisionOutcome(res, { decision: sent, stepNo: stepNo ?? r?.approvalCurrentStep ?? null });
    const names = out.waitingFor.length ? out.waitingFor.join(', ') : t('decision.nextApprover');
    const title = out.key === 'advanced' ? t('decision.advanced', { n: out.level ?? 1, names })
      : out.key === 'approvalRecorded' || out.key === 'rejectionRecorded' ? t(`decision.${out.key}`, { names })
      : t(`decision.${out.key}`);
    if (out.key === 'approved' && res.recalculationJobId) toast.success(title, { description: t('records.recalcHint'), action: { label: t('records.viewRecalc'), onClick: () => navigate('/attendance?tab=recalc') } });
    else toast.success(title);
  };
  const submit = () => {
    if (!decision || !r || missing || seatMissing) return;
    updateRecord.mutate({ id: r.id, input: { status: decision.status, decisionNote: note.trim() || null, ...(stepNo !== null ? { stepNo } : {}), ...(mustChoose && target ? { onBehalfOfUserId: target } : {}) } }, {
      onSuccess: (res) => { announce(res, decision.status); setNote(''); setChosen(''); onClose(); },
      onError: (e) => toastMutationError(e, navigate),
    });
  };
  return (
    <Dialog open={!!decision} onOpenChange={(o) => { if (!o) { setNote(''); setChosen(''); onClose(); } }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{approve ? t('decision.approveTitle') : t('decision.rejectTitle')}</DialogTitle>
          <DialogDescription>{r ? `${r.employeeName ?? ''} · ${r.leaveTypeName ?? ''} · ${r.startDate === r.endDate ? fmtDate(r.startDate) : `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}`}` : null}</DialogDescription>
        </DialogHeader>
        {stepNo !== null && r?.approvalStepCount ? <p className="text-xs text-muted-foreground" data-testid="decision-level">{t('decision.atLevel', { n: stepNo, count: r.approvalStepCount })}</p> : null}
        {r?.reason ? <p className="rounded-md border bg-muted/30 p-3 text-sm"><span className="font-medium">{t('fields.reason')}:</span> {r.reason}</p> : null}
        {mustChoose ? (
          <FormField label={t('decision.decidingFor')} htmlFor="leave-decision-seat" required hint={t('decision.decidingForHint')}>
            <Select value={chosen} onValueChange={setChosen}>
              <SelectTrigger id="leave-decision-seat" aria-invalid={seatMissing || undefined}><SelectValue placeholder={t('decision.decidingForPlaceholder')} /></SelectTrigger>
              <SelectContent>{seats.map((s) => <SelectItem key={s.userId} value={s.userId}>{s.userName ?? s.userId.slice(0, 8)}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
        ) : null}
        <FormField label={t('decision.note')} htmlFor="leave-decision-note" optional={approve} required={!approve} hint={approve ? t('decision.noteHint') : t('decision.noteRequired')}>
          <Textarea id="leave-decision-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} aria-invalid={missing || undefined} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => { setNote(''); onClose(); }}>{tc('common.cancel')}</Button>
          <Button type="button" variant={approve ? 'default' : 'destructive'} disabled={missing || seatMissing} loading={updateRecord.isPending} onClick={submit}>{approve ? <Check /> : <X />} {approve ? t('decision.approve') : t('decision.reject')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordsTab() {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const canManage = can('leave.manage');
  const table = useTabTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, employeeId: f['employeeId'], branchId: f['branchId'], leaveTypeId: f['leaveTypeId'], status: f['status'], from: f['from'], to: f['to'] }), [table.state.page, table.state.pageSize, f]);
  const q = useLeaveRecords(query);
  const employees = useEmployeeOptions();
  const branches = useBranchOptions();
  const types = useLeaveTypeOptions();
  const { cancelRecord } = useLeaveMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<LeaveRecordDto | null>(null);
  const [cancelling, setCancelling] = useState<LeaveRecordDto | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [detail, setDetail] = useState<LeaveRecordDto | null>(null);
  const hasFilters = ['employeeId', 'branchId', 'leaveTypeId', 'status', 'from', 'to'].some((k) => !!f[k]);
  const employeeOptions = useMemo(() => (f['employeeId'] && !employees.options.some((o) => o.value === f['employeeId']) ? [{ value: f['employeeId'], label: t('records.selectedEmployee') }, ...employees.options] : employees.options), [employees.options, f, t]);

  const columns = useMemo<ColumnDef<LeaveRecordDto, unknown>[]>(() => [
    { id: 'employee', header: t('fields.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? '—'}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    { id: 'type', header: t('fields.leaveType'), cell: ({ row }) => { const lt = types.byId.get(row.original.leaveTypeId); return <span className="flex items-center gap-2"><LeaveTypeDot color={row.original.color ?? lt?.color} />{row.original.leaveTypeName ?? lt?.name ?? '—'}{lt && !lt.isPaid ? <Badge variant="outline">{t('types.unpaid')}</Badge> : null}{row.original.compOff ? <Badge variant="info">{t('compOff.badge')}</Badge> : null}</span>; } },
    { id: 'range', header: t('records.range'), cell: ({ row }) => <div className="text-xs"><LeaveRange r={row.original} />{row.original.days !== null && row.original.days !== undefined ? <span className="block text-muted-foreground tnum">{t('records.daysCount', { count: row.original.days, days: fmtLeaveDays(row.original.days) })}</span> : null}</div> },
    { id: 'reason', header: t('fields.reason'), cell: ({ row }) => <div className="max-w-[240px] text-xs"><span className="block truncate" title={row.original.reason ?? undefined}>{row.original.reason ?? '—'}</span>{row.original.decisionNote ? <span className="block truncate text-muted-foreground" title={row.original.decisionNote}>{t('decision.noteShort', { note: row.original.decisionNote })}</span> : null}{row.original.commentCount ? <span className="mt-0.5 flex items-center gap-1 text-muted-foreground"><MessageSquare className="size-3" aria-hidden />{t('records.comments', { count: row.original.commentCount })}</span> : null}</div> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <LeaveStatusBadge status={row.original.status} /> },
    { id: 'approval', header: t('records.approval'), cell: ({ row }) => <ApprovalCell r={row.original} /> },
    { id: 'source', header: t('records.source'), cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.source}</span> },
    { id: 'createdAt', header: tc('common.createdAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz)}</span> },
    { id: 'actions', header: '', cell: ({ row }) => {
      const r = row.original;
      if (!canManage || r.status === 'CANCELLED') return null;
      const undecided = UNDECIDED_LEAVE_STATUSES.includes(r.status);
      const more: RowAction[] = [];
      if (r.status !== 'REJECTED') more.push({ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setEditing(r) });
      if (!undecided && r.status !== 'REJECTED') more.push({ key: 'cancel', label: t('records.cancel'), icon: <Ban />, destructive: true, onSelect: () => setCancelling(r) });
      if (undecided) more.push({ key: 'cancel', label: t('records.cancelRequest'), icon: <Ban />, destructive: true, onSelect: () => setCancelling(r) });
      return (
        <div className="flex items-center justify-end gap-1">
          {undecided ? <>
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setDecision({ record: r, status: 'APPROVED' }); }}><Check /> {t('decision.approve')}</Button>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setDecision({ record: r, status: 'REJECTED' }); }}><X /> {t('decision.reject')}</Button>
          </> : null}
          <RowActions actions={more} />
        </div>
      );
    } },
  ], [t, tc, tz, types.byId, canManage]);

  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="leave-records"
        onRowClick={setDetail}
        emptyTitle={t('records.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('records.emptyHint')}
        emptyAction={!hasFilters && canManage ? <Button onClick={() => setCreateOpen(true)}><Plus /> {t('records.add')}</Button> : undefined}
        toolbar={
          <>
            <Combobox value={f['employeeId'] ?? null} onChange={(v) => table.setFilter('employeeId', v ?? undefined)} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('fields.employee')} className="h-8 w-48" />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={f['leaveTypeId'] ?? null} onChange={(v) => table.setFilter('leaveTypeId', v ?? undefined)} options={types.options} loading={types.isLoading} clearable placeholder={t('fields.leaveType')} className="h-8 w-40" />
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>{LEAVE_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <DateRange idPrefix="leave" from={f['from']} to={f['to']} onChange={({ from, to }) => table.update({ filters: { from: from ?? '', to: to ?? '' } })} />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { employeeId: '', branchId: '', leaveTypeId: '', status: '', from: '', to: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
            {canManage ? <Button size="sm" className="ms-auto" onClick={() => setCreateOpen(true)}><Plus /> {t('records.add')}</Button> : null}
          </>
        }
        renderCard={(r) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.employeeName}</span><LeaveStatusBadge status={r.status} /></div><p className="text-xs text-muted-foreground tnum">{r.leaveTypeName} · {fmtDate(r.startDate)} → {fmtDate(r.endDate)}{r.days !== null && r.days !== undefined ? ` · ${fmtLeaveDays(r.days)}` : ''}</p></div>}
      />
      <LeaveRecordDialog key={String(createOpen)} open={createOpen} onOpenChange={setCreateOpen} />
      <LeaveRecordDialog key={`edit-${editing?.id ?? ''}`} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} record={editing} />
      <DecisionDialog decision={decision} onClose={() => setDecision(null)} />
      <LeaveRecordDetailDialog record={detail} onClose={() => setDetail(null)} />
      <ConfirmDialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)} title={cancelling && UNDECIDED_LEAVE_STATUSES.includes(cancelling.status) ? t('records.cancelRequestTitle') : t('records.cancelTitle')} description={t('records.cancelHint')} confirmLabel={t('records.cancel')} destructive loading={cancelRecord.isPending}
        onConfirm={() => { if (!cancelling) return; cancelRecord.mutate(cancelling.id, { onSuccess: (r) => { if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('records.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(t('records.cancelled')); setCancelling(null); }, onError: (e) => toastMutationError(e, navigate) }); }} />
    </>
  );
}

/** One line of the type's policy: approval, counting, notice / cap, carry-forward. */
function PolicySummary({ lt }: { lt: LeaveTypeDto }) {
  const { t } = useTranslation('leave');
  const { t: te } = useTranslation('employees');
  const bits: string[] = [];
  if (lt.requiresApproval === false) bits.push(t('types.chips.noApproval'));
  if (lt.countMode === 'calendar') bits.push(t('types.chips.calendarDays'));
  if (lt.advanceNoticeDays) bits.push(t('types.chips.notice', { count: lt.advanceNoticeDays }));
  if (lt.maxConsecutiveDays) bits.push(t('types.chips.maxConsecutive', { count: lt.maxConsecutiveDays }));
  if (lt.accrual === 'monthly') bits.push(t('types.chips.monthly'));
  if (lt.carryForwardMaxDays) bits.push(t('types.chips.carryForward', { count: lt.carryForwardMaxDays }));
  if (lt.applicableGender && lt.applicableGender !== 'all') bits.push(t(`genders.${lt.applicableGender}`));
  if (lt.applicableEmploymentTypes?.length) bits.push(t('types.chips.employmentTypes', { types: lt.applicableEmploymentTypes.map((x) => te(`employmentType.${x}`)).join(' / ') }));
  if (lt.portalVisible === false && !lt.compOff) bits.push(t('types.chips.hrOnly'));
  if (lt.isSpecial && !lt.compOff) bits.push(t('types.chips.special'));
  return bits.length ? <div className="flex max-w-[320px] flex-wrap gap-1">{bits.map((b) => <Badge key={b} variant="secondary" className="font-normal">{b}</Badge>)}</div> : <span className="text-xs text-muted-foreground">—</span>;
}

function TypesTab() {
  const { t } = useTranslation('leave');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('leave.manage');
  const q = useLeaveTypes();
  const { updateType, removeType, seedDefaults } = useLeaveMutations();
  const [dialog, setDialog] = useState<{ open: boolean; leaveType: LeaveTypeDto | null }>({ open: false, leaveType: null });
  const [deleting, setDeleting] = useState<LeaveTypeDto | null>(null);
  const actionsFor = (lt: LeaveTypeDto): RowAction[] => lt.compOff
    ? [{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, leaveType: lt }) }]
    : [{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, leaveType: lt }) }, { key: 'toggle', label: lt.status === 'active' ? t('types.deactivate') : t('types.activate'), onSelect: () => updateType.mutate({ id: lt.id, input: { status: lt.status === 'active' ? 'inactive' : 'active' } }, { onSuccess: () => toast.success(t('types.updated')), onError: toastError }) }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(lt) }];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2"><p className="text-sm text-muted-foreground">{t('types.hint')}</p>{canManage ? <Button size="sm" onClick={() => setDialog({ open: true, leaveType: null })}><Plus /> {t('types.add')}</Button> : null}</div>
      <div className="rounded-lg border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading ? <TableSkeleton cols={6} rows={3} />
          : !q.data || q.data.length === 0 ? <div className="p-4"><EmptyState icon={CalendarOff} title={t('types.empty')} description={t('types.emptyHint')} action={canManage ? <div className="flex flex-wrap justify-center gap-2"><Button onClick={() => seedDefaults.mutate(undefined, { onSuccess: (r) => toast.success(t('types.seeded', { count: r.created.length })), onError: toastError })} loading={seedDefaults.isPending}>{t('types.seed')}</Button><Button variant="outline" onClick={() => setDialog({ open: true, leaveType: null })}><Plus /> {t('types.add')}</Button></div> : undefined} /></div>
          : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>{tc('common.code')}</TableHead><TableHead>{tc('common.name')}</TableHead><TableHead>{t('fields.isPaid')}</TableHead><TableHead>{t('types.allowance')}</TableHead><TableHead>{t('types.policyColumn')}</TableHead><TableHead>{tc('common.status')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {q.data.map((lt) => (
                    <TableRow key={lt.id}>
                      <TableCell><span className="flex items-center gap-2 font-mono text-xs" dir="ltr"><LeaveTypeDot color={lt.color} />{lt.code}</span></TableCell>
                      <TableCell><p className="flex items-center gap-2 font-medium">{lt.name}{lt.compOff ? <Badge variant="info">{t('types.system')}</Badge> : null}</p>{lt.nameAr ? <p className="text-xs text-muted-foreground" dir="rtl">{lt.nameAr}</p> : null}</TableCell>
                      <TableCell>{lt.isPaid ? <Badge variant="success">{t('types.paid')}</Badge> : <Badge variant="outline">{t('types.unpaid')}</Badge>}</TableCell>
                      <TableCell className="tnum text-sm">{lt.compOff ? <span className="text-muted-foreground">{t('types.fromCredits')}</span> : lt.annualAllowanceDays === null ? <span className="text-muted-foreground">{t('types.notTracked')}</span> : t('types.daysPerYear', { count: lt.annualAllowanceDays })}</TableCell>
                      <TableCell><PolicySummary lt={lt} /></TableCell>
                      <TableCell><Badge variant={lt.status === 'active' ? 'success' : 'neutral'} dot>{t(`recordStatus.${lt.status}`, { defaultValue: lt.status })}</Badge></TableCell>
                      <TableCell>{canManage ? <RowActions actions={actionsFor(lt)} /> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
      </div>
      <LeaveTypeDialog key={`${dialog.open}-${dialog.leaveType?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} leaveType={dialog.leaveType} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('types.deleteTitle', { name: deleting?.name ?? '' })} description={t('types.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={removeType.isPending}
        onConfirm={() => { if (!deleting) return; removeType.mutate(deleting.id, { onSuccess: () => { toast.success(t('types.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}

/** /leave?tab=records|calendar|balances|allocations|types */
export default function LeavePage() {
  const { t } = useTranslation('leave');
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'records';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')} className="max-w-full overflow-x-auto">{TABS.map((tb) => <TabsTrigger key={tb} value={tb}>{t(`tabs.${tb}`)}</TabsTrigger>)}</TabsList>
        <TabsContent value="records">{tab === 'records' ? <RecordsTab /> : null}</TabsContent>
        <TabsContent value="calendar">{tab === 'calendar' ? <LeaveCalendarTab /> : null}</TabsContent>
        <TabsContent value="balances">{tab === 'balances' ? <BalancesTab /> : null}</TabsContent>
        <TabsContent value="allocations">{tab === 'allocations' ? <AllocationsTab /> : null}</TabsContent>
        <TabsContent value="types">{tab === 'types' ? <TypesTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}
