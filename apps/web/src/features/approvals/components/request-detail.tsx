import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, HelpCircle, MessageSquareReply, Undo2, UserRoundCog, X } from 'lucide-react';
import type { ApprovalRequestDto, ApprovalStepDto, ApprovalTimelineEventDto } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Skeleton, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useDebounced } from '@/hooks/use-debounced';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useApprovalMutations, useApprovalRequest, useDelegateCandidates, type DecisionKind } from '../api';
import { DecisionDialog } from './decision-dialog';
import { modeText, pathText } from '../labels';
import { ApprovalContext, EntityIcon, LevelLabel, RequestStatusBadge } from './parts';

/** A small text prompt (ask for information, answer, withdraw reason). */
function TextPrompt({ open, title, hint, label, placeholder, required, loading, confirmLabel, destructive, onSubmit, onClose }: { open: boolean; title: string; hint: string; label: string; placeholder?: string; required: boolean; loading: boolean; confirmLabel: string; destructive?: boolean; onSubmit: (text: string) => void; onClose: () => void }) {
  const { t: tc } = useTranslation();
  const [text, setText] = useState('');
  const missing = required && text.trim().length === 0;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{hint}</DialogDescription></DialogHeader>
        <FormField label={label} htmlFor="prompt-text" required={required} optional={!required}>
          <Textarea id="prompt-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant={destructive ? 'destructive' : 'default'} disabled={missing} loading={loading} onClick={() => onSubmit(text.trim())}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReassignDialog({ request, onClose }: { request: ApprovalRequestDto | null; onClose: () => void }) {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);
  const candidates = useDelegateCandidates(debounced, !!request);
  const [userId, setUserId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { reassign } = useApprovalMutations();
  const options = useMemo(() => (candidates.data ?? []).filter((c) => c.userId !== request?.subjectUserId).map((c) => ({ value: c.userId, label: c.fullName || c.email, description: c.email })), [candidates.data, request?.subjectUserId]);
  const invalid = !userId || reason.trim().length < 3;
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('reassign.title')}</DialogTitle><DialogDescription>{t('reassign.hint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <FormField label={t('reassign.user')} htmlFor="reassign-user" required>
            <Combobox id="reassign-user" value={userId} onChange={setUserId} options={options} onSearch={setSearch} loading={candidates.isLoading} placeholder={t('delegations.pickDelegate')} />
          </FormField>
          <FormField label={t('reassign.reason')} htmlFor="reassign-reason" required>
            <Textarea id="reassign-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('reassign.reasonPlaceholder')} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" disabled={invalid} loading={reassign.isPending} onClick={() => { if (!request || !userId) return; reassign.mutate({ requestId: request.id, userId, reason: reason.trim(), stepNo: request.currentStep }, { onSuccess: () => { toast.success(t('reassign.done')); onClose(); }, onError: toastError }); }}>{t('actions.reassign')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepCard({ step, current, pending, timezone }: { step: ApprovalStepDto; current: boolean; pending: boolean; timezone: string }) {
  const { t } = useTranslation('approvals');
  return (
    <li className={current && pending ? 'rounded-md border border-primary/40 bg-primary/5 p-3' : 'rounded-md border p-3'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium"><span className="tnum">{t('levelN', { n: step.stepNo })}</span>{' '}
          <span className="text-muted-foreground">· {t(`approverType.${step.approverType}`)} · {modeText(t, step)}</span></p>
        <RequestStatusBadge status={step.status} />
      </div>
      {step.resolutionReason ? <p className="mt-1 text-xs text-muted-foreground">{pathText(t, step.resolutionPath)} — {step.resolutionReason}</p> : null}
      {step.dueAt && step.status === 'PENDING' ? <p className="mt-1 text-xs text-muted-foreground tnum">{t('workflows.escalation')}: {fmtDateTime(step.dueAt, timezone)}{step.escalatedAt ? ' ✓' : ''}</p> : null}
      <ul className="mt-2 space-y-1.5">
        {step.actors.map((a) => (
          <li key={`${a.userId}-${a.viaDelegationOf ?? ''}`} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{a.userName ?? a.userId.slice(0, 8)}</span>
            {a.viaDelegationOf ? <Badge variant="info">{t('inbox.delegateOf', { name: a.viaDelegationOfName ?? a.viaDelegationOf.slice(0, 8) })}</Badge> : null}
            {a.resolutionPath && a.resolutionPath !== 'delegate' ? <span className="text-xs text-muted-foreground">{pathText(t, a.resolutionPath)}</span> : null}
            <RequestStatusBadge status={a.decision} />
            {a.decidedAt ? <span className="text-xs text-muted-foreground tnum">{fmtDateTime(a.decidedAt, timezone)}</span> : null}
            {a.comment ? <span className="basis-full text-xs text-muted-foreground">“{a.comment}”</span> : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

function eventText(t: (k: string, o?: Record<string, unknown>) => string, e: ApprovalTimelineEventDto): string {
  return t(`timeline.${e.kind}`, { stepNo: e.detail['stepNo'] ?? '', defaultValue: t('timeline.unknown') });
}

function Timeline({ events, timezone }: { events: ApprovalTimelineEventDto[]; timezone: string }) {
  const { t } = useTranslation('approvals');
  if (!events.length) return <p className="text-sm text-muted-foreground">{t('detail.noEvents')}</p>;
  return (
    <ol className="relative space-y-3 border-s ps-4">
      {events.map((e) => {
        const comment = typeof e.detail['comment'] === 'string' ? e.detail['comment'] : typeof e.detail['reason'] === 'string' ? e.detail['reason'] : null;
        return (
          <li key={e.id} className="relative">
            <span className="absolute -start-[21px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary" aria-hidden />
            <p className="text-sm"><span className="font-medium">{eventText(t, e)}</span> <span className="text-muted-foreground">· {e.actorName ?? t('detail.system')}</span></p>
            <p className="text-xs text-muted-foreground tnum">{fmtDateTime(e.at, timezone)}</p>
            {comment ? <p className="mt-0.5 text-xs">“{comment}”</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One request: what it is about, every level with its approvers (delegates, escalations, overrides) and decisions, the
 * timeline, and the actions the caller may take right now (from the API's `abilities` — the API re-checks each one).
 */
export function RequestDetail({ requestId }: { requestId: string }) {
  const { t } = useTranslation('approvals');
  const tz = useOrgTimezone();
  const q = useApprovalRequest(requestId);
  const { cancel, requestInfo, answerInfo } = useApprovalMutations();
  const [decision, setDecision] = useState<DecisionKind | null>(null);
  const [prompt, setPrompt] = useState<'ask' | 'answer' | 'withdraw' | null>(null);
  const [reassigning, setReassigning] = useState(false);
  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (q.isError) return (q.error as { status?: number }).status === 404 ? <EmptyState title={t('detail.notFound')} /> : <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const r = q.data;
  if (!r) return null;
  const pending = r.status === 'PENDING';
  const a = r.abilities;
  const closePrompt = () => setPrompt(null);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <EntityIcon entityType={r.entityType} className="size-10" />
          <div className="min-w-0">
            <p className="text-base font-semibold">{t(`entity.${r.entityType}`)} — {r.employeeName ?? '—'} <span className="font-mono text-xs font-normal text-muted-foreground" dir="ltr">{r.employeeNumber}</span></p>
            <p className="text-xs text-muted-foreground">{t('detail.requestedBy', { name: r.requestedByName ?? '—' })} · {t('detail.submitted', { when: fmtDateTime(r.createdAt, tz) })}{r.workflowName ? ` · ${r.workflowName}` : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-2"><LevelLabel request={r} /><RequestStatusBadge status={r.status} /></div>
      </div>

      {pending && r.infoRequestedAt ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100" role="status"><HelpCircle className="me-1 inline size-4" aria-hidden />{t('detail.infoRequested')}</p> : null}
      {r.cancelReason ? <p className="text-sm text-muted-foreground">{t('detail.cancelReason', { reason: r.cancelReason })}</p> : null}
      {r.invalidationReason ? <p className="text-sm text-muted-foreground">{t('detail.invalidationReason', { reason: r.invalidationReason })}</p> : null}

      <div className="rounded-md border bg-muted/30 p-3"><ApprovalContext context={r.context} timezone={tz} /></div>

      {pending && (a.canDecide || a.canRequestInfo || a.canAnswerInfo || a.canReassign || a.canCancel) ? (
        <div className="flex flex-wrap gap-2">
          {a.canDecide ? <><Button size="sm" onClick={() => setDecision('APPROVE')}><Check /> {t('actions.approve')}</Button><Button size="sm" variant="outline" onClick={() => setDecision('REJECT')}><X /> {t('actions.reject')}</Button></> : null}
          {a.canRequestInfo ? <Button size="sm" variant="outline" onClick={() => setPrompt('ask')}><HelpCircle /> {t('actions.askInfo')}</Button> : null}
          {a.canAnswerInfo && r.infoRequestedAt ? <Button size="sm" variant="outline" onClick={() => setPrompt('answer')}><MessageSquareReply /> {t('actions.answer')}</Button> : null}
          {a.canReassign ? <Button size="sm" variant="outline" onClick={() => setReassigning(true)}><UserRoundCog /> {t('actions.reassign')}</Button> : null}
          {a.canCancel ? <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setPrompt('withdraw')}><Undo2 /> {t('actions.withdraw')}</Button> : null}
        </div>
      ) : null}

      <section className="space-y-2">
        <h4 className="text-sm font-semibold">{t('detail.levels')}</h4>
        <ol className="space-y-2">{r.steps.map((s) => <StepCard key={s.id} step={s} current={s.stepNo === r.currentStep} pending={pending} timezone={tz} />)}</ol>
      </section>
      <section className="space-y-2">
        <h4 className="text-sm font-semibold">{t('detail.timeline')}</h4>
        <Timeline events={r.events ?? []} timezone={tz} />
      </section>

      <DecisionDialog key={`${r.id}-${decision ?? ''}`} request={decision ? r : null} decision={decision ?? 'APPROVE'} timezone={tz} onClose={() => setDecision(null)} />
      <ReassignDialog key={`reassign-${String(reassigning)}`} request={reassigning ? r : null} onClose={() => setReassigning(false)} />
      <TextPrompt key={`ask-${prompt}`} open={prompt === 'ask'} title={t('info.askTitle')} hint={t('info.askHint')} label={t('decision.comment')} placeholder={t('info.placeholder')} required loading={requestInfo.isPending} confirmLabel={t('actions.askInfo')} onClose={closePrompt}
        onSubmit={(comment) => requestInfo.mutate({ requestId: r.id, comment }, { onSuccess: () => { toast.success(t('info.asked')); closePrompt(); }, onError: toastError })} />
      <TextPrompt key={`answer-${prompt}`} open={prompt === 'answer'} title={t('info.answerTitle')} hint={t('info.answerHint')} label={t('decision.comment')} placeholder={t('info.placeholder')} required loading={answerInfo.isPending} confirmLabel={t('actions.answer')} onClose={closePrompt}
        onSubmit={(comment) => answerInfo.mutate({ requestId: r.id, comment }, { onSuccess: () => { toast.success(t('info.answered')); closePrompt(); }, onError: toastError })} />
      <TextPrompt key={`withdraw-${prompt}`} open={prompt === 'withdraw'} title={t('withdraw.title')} hint={t('withdraw.hint')} label={t('withdraw.reason')} required={false} loading={cancel.isPending} confirmLabel={t('actions.withdraw')} destructive onClose={closePrompt}
        onSubmit={(reason) => cancel.mutate({ requestId: r.id, reason }, { onSuccess: () => { toast.success(t('withdraw.done')); closePrompt(); }, onError: toastError })} />
    </div>
  );
}

/** The request as a side panel over the inbox (a wide dialog; deep-linkable through /approvals/requests/:id). */
export function RequestDialog({ requestId, onClose }: { requestId: string | null; onClose: () => void }) {
  const { t } = useTranslation('approvals');
  return (
    <Dialog open={!!requestId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('detail.title')}</DialogTitle><DialogDescription className="sr-only">{t('detail.timeline')}</DialogDescription></DialogHeader>
        {requestId ? <RequestDetail requestId={requestId} /> : null}
      </DialogContent>
    </Dialog>
  );
}
