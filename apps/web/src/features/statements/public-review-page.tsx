import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import i18next from 'i18next';
import { CheckCircle2, Clock3, FileWarning, Loader2, PenLine } from 'lucide-react';
import type { StatementSnapshot } from '@flowza/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/statements.json';
import ar from '@/locales/ar/statements.json';
import { submitStatementByToken, viewStatementByToken } from './api';
import { StatementDocument } from './components/statement-document';

registerNamespace('statements', en, ar);

/**
 * The employee's review-and-sign page (docs/statements.md), reached only from the emailed link — no sign-in, the
 * token is the credential. Renders in the STATEMENT's locale (the organisation's language), not the browser
 * preference: the page is the document being signed. Comments are per day, sign-in/out disputes only; the typed full
 * name plus the confirmation box is the digital signature.
 */
export default function PublicStatementReviewPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const view = useQuery({
    queryKey: ['portal-statement', token],
    queryFn: () => viewStatementByToken(token),
    enabled: token.length > 0,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: Infinity,
  });

  const locale: 'en' | 'ar' = view.data?.snapshot.organization.locale ?? 'en';
  const t = useMemo(() => i18next.getFixedT(locale, 'statements'), [locale]);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  useEffect(() => { document.title = t('review.pageTitle'); }, [t]);

  return (
    <div dir={dir} lang={locale} className="min-h-screen bg-muted/30 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-4xl space-y-4 px-3 sm:px-6">
        {!token ? (
          <ErrorCard t={t} title={t('review.invalidTitle')} body={t('review.invalidBody')} />
        ) : view.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground"><Loader2 className="size-5 animate-spin" aria-hidden /> {t('review.loading')}</div>
        ) : view.isError ? (
          <ErrorCard
            t={t}
            title={view.error instanceof ApiError && view.error.status === 409 ? t('review.expiredTitle') : t('review.invalidTitle')}
            body={view.error instanceof ApiError && view.error.status === 409 ? t('review.expiredBody') : t('review.invalidBody')}
          />
        ) : view.data ? (
          <ReviewBody token={token} data={view.data} refetch={() => void view.refetch()} t={t} />
        ) : null}
      </div>
    </div>
  );
}

type FixedT = ReturnType<typeof i18next.getFixedT>;

function Callout({ tone, title, body }: { tone: 'info' | 'error'; title: string; body: string }) {
  return (
    <div className={cn('rounded-lg border px-3.5 py-2.5 text-sm', tone === 'info' ? 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100' : 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100')} role={tone === 'error' ? 'alert' : undefined}>
      <p className="font-medium">{title}</p>
      <p className="mt-0.5 opacity-90">{body}</p>
    </div>
  );
}

function ErrorCard({ t, title, body }: { t: FixedT; title: string; body: string }) {
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg"><FileWarning className="size-5 text-amber-600" aria-hidden /> {title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function ReviewBody({ token, data, refetch, t }: { token: string; data: Awaited<ReturnType<typeof viewStatementByToken>>; refetch: () => void; t: FixedT }) {
  const snapshot: StatementSnapshot = data.snapshot;
  const readOnly = data.status !== 'ISSUED';
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [signedName, setSignedName] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const submit = useMutation({
    mutationFn: submitStatementByToken,
    onSuccess: refetch,
  });

  const comments = Object.entries(drafts)
    .map(([date, comment]) => ({ date, comment: comment.trim() }))
    .filter((c) => c.comment.length > 0);

  const onSubmit = () => {
    if (!confirmed || signedName.trim().length < 2) return;
    submit.mutate({ token, signedName: signedName.trim(), comments });
  };

  return (
    <>
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{snapshot.organization.name}</p>
              <CardTitle className="text-xl">{t('review.title', { period: snapshot.period.label })}</CardTitle>
              <CardDescription className="mt-1">
                {snapshot.employee.name} · <span dir="ltr">{snapshot.employee.employeeNumber}</span>
                {snapshot.employee.departmentName ? <> · {snapshot.employee.departmentName}</> : null}
                {snapshot.employee.branchName ? <> · {snapshot.employee.branchName}</> : null}
              </CardDescription>
            </div>
            <StatusBanner data={data} t={t} />
          </div>
          {!readOnly ? (
            <Callout tone="info" title={t('review.introTitle')} body={t('review.introBody')} />
          ) : null}
        </CardHeader>
        <CardContent>
          <StatementDocument
            snapshot={snapshot}
            comments={data.comments}
            t={t}
            dayExtra={readOnly ? undefined : (day) => {
              if (!day.commentable) return null;
              if (!editing[day.date]) {
                return (
                  <button type="button" className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setEditing((e) => ({ ...e, [day.date]: true }))}>
                    <PenLine className="me-1 inline size-3.5" aria-hidden />{drafts[day.date]?.trim() ? t('review.editComment') : t('review.addComment')}
                    {drafts[day.date]?.trim() ? <span className="ms-2 font-normal text-muted-foreground">{drafts[day.date]}</span> : null}
                  </button>
                );
              }
              return (
                <div className="space-y-1.5">
                  <Textarea
                    autoFocus
                    rows={2}
                    maxLength={1000}
                    value={drafts[day.date] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [day.date]: e.target.value }))}
                    placeholder={t('review.commentPlaceholder')}
                    aria-label={t('review.commentFor', { date: day.dateLabel })}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing((e) => ({ ...e, [day.date]: false }))}>{t('review.done')}</Button>
                    {drafts[day.date]?.trim() ? (
                      <Button size="sm" variant="ghost" onClick={() => { setDrafts((d) => ({ ...d, [day.date]: '' })); setEditing((e) => ({ ...e, [day.date]: false })); }}>{t('review.removeComment')}</Button>
                    ) : null}
                  </div>
                </div>
              );
            }}
          />
        </CardContent>
      </Card>

      {!readOnly ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('sign.title')}</CardTitle>
            <CardDescription>{comments.length > 0 ? t('sign.withComments', { count: comments.length }) : t('sign.noComments')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-sm space-y-1.5">
              <label htmlFor="signed-name" className="text-sm font-medium">{t('sign.nameLabel')}</label>
              <Input id="signed-name" value={signedName} onChange={(e) => setSignedName(e.target.value)} maxLength={120} placeholder={t('sign.namePlaceholder')} autoComplete="name" />
            </div>
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" aria-label={t('sign.confirmLabel')} />
              <span>{t('sign.confirmText')}</span>
            </label>
            {submit.isError ? (
              <Callout tone="error" title={t('sign.failedTitle')} body={submit.error instanceof ApiError ? submit.error.message : t('sign.failedBody')} />
            ) : null}
            <Button onClick={onSubmit} disabled={!confirmed || signedName.trim().length < 2 || submit.isPending} loading={submit.isPending}>
              {t('sign.submit')}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function StatusBanner({ data, t }: { data: Awaited<ReturnType<typeof viewStatementByToken>>; t: FixedT }) {
  if (data.status === 'ISSUED') return null;
  const finalized = data.status === 'FINALIZED';
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium', finalized ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200')}>
      {finalized ? <CheckCircle2 className="size-4" aria-hidden /> : <Clock3 className="size-4" aria-hidden />}
      <span>
        {finalized
          ? data.finalizedReason === 'MANAGER_APPROVED'
            ? t('status.finalApproved')
            : t('status.finalConfirmed', { name: data.signedName ?? '' })
          : t('status.pendingApproval')}
      </span>
    </div>
  );
}
