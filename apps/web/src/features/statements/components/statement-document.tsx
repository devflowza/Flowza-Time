import type { ReactNode } from 'react';
import type { StatementCommentDto, StatementSnapshot } from '@flowza/contracts';
import { MessageSquareText } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { TFunction } from 'i18next';

/**
 * The statement as a document: the day table and the totals block, rendered from the snapshot's own prebuilt display
 * strings (organisation zone, notation and clock were fixed at issue time — nothing is recomputed in the browser).
 * Shared by the admin detail page and the public review page; `dayExtra` lets the review page attach its per-day
 * comment editor to each commentable row.
 */
export interface StatementDocumentProps {
  snapshot: StatementSnapshot;
  comments: StatementCommentDto[];
  t: TFunction;
  /** Extra cell content under a day row (the review page's comment editor). */
  dayExtra?: (day: StatementSnapshot['days'][number]) => ReactNode;
}

const STATUS_TONE: Record<string, string> = {
  PRESENT: 'text-emerald-700 dark:text-emerald-300',
  ABSENT: 'text-red-700 dark:text-red-300',
  LEAVE: 'text-sky-700 dark:text-sky-300',
  HOLIDAY: 'text-violet-700 dark:text-violet-300',
  WEEKLY_OFF: 'text-muted-foreground',
  HALF_DAY: 'text-amber-700 dark:text-amber-300',
  MISSING_PUNCH: 'text-amber-700 dark:text-amber-300',
};

export function StatementDocument({ snapshot, comments, t, dayExtra }: StatementDocumentProps) {
  const byDate = new Map(comments.map((c) => [c.attendanceDate, c]));
  const totals = snapshot.totals;
  const negative = totals.differenceMinutes < 0;

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-start text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 text-start font-medium">{t('doc.date')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('doc.day')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('doc.code')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('doc.signIn')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('doc.signOut')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('doc.worked')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('doc.late')}</th>
              <th className="px-3 py-2 text-start font-medium">{t('doc.comment')}</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.days.map((d) => {
              const comment = byDate.get(d.date);
              const extra = dayExtra?.(d);
              const off = d.status === 'WEEKLY_OFF' || d.status === 'HOLIDAY' || d.status === 'NOT_JOINED' || d.status === 'EXITED';
              return (
                <FragmentRow key={d.date} extra={extra}>
                  <tr className={cn('border-b last:border-0', off && 'bg-muted/20 text-muted-foreground', comment && 'bg-amber-50/60 dark:bg-amber-950/20')}>
                    <td className="whitespace-nowrap px-3 py-1.5 tnum" dir="ltr">{d.dateLabel}</td>
                    <td className="px-3 py-1.5">{d.weekdayLabel}</td>
                    <td className={cn('px-3 py-1.5 font-medium', STATUS_TONE[d.status])} title={d.leave?.name ?? d.status}>{d.code}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 tnum" dir="ltr">{d.signIn}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 tnum" dir="ltr">{d.signOut}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 tnum" dir="ltr">{d.workedLabel}</td>
                    <td className={cn('whitespace-nowrap px-3 py-1.5 tnum', d.lateMinutes > 0 && 'text-amber-700 dark:text-amber-300')} dir="ltr">{d.lateMinutes > 0 ? d.lateMinutes : ''}</td>
                    <td className="max-w-[16rem] px-3 py-1.5">
                      {comment ? (
                        <span className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
                          <MessageSquareText className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                          <span className="whitespace-pre-wrap break-words">{comment.comment}</span>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border bg-muted/20 p-4">
        <h3 className="mb-3 text-sm font-semibold">{t('doc.summaryTitle')}</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <SummaryItem label={t('doc.required')} value={totals.requiredLabel} />
          <SummaryItem label={t('doc.workedTotal')} value={totals.workedLabel} />
          <SummaryItem
            label={t('doc.difference')}
            value={totals.differenceLabel}
            className={negative ? 'text-red-700 dark:text-red-300' : totals.differenceMinutes > 0 ? 'text-emerald-700 dark:text-emerald-300' : undefined}
          />
          <SummaryItem label={t('doc.totalDelay')} value={totals.delayLabel} className={totals.delayMinutes > 0 ? 'text-amber-700 dark:text-amber-300' : undefined} hint={t('doc.lateDays', { count: totals.lateDays })} />
          <SummaryItem label={t('doc.overtime')} value={totals.overtimeLabel} />
          <SummaryItem label={t('doc.workingDays')} value={String(totals.workingDays)} />
          <SummaryItem label={t('doc.presentDays')} value={fmtDays(totals.presentDays)} />
          <SummaryItem label={t('doc.absentDays')} value={fmtDays(totals.absentDays)} className={totals.absentDays > 0 ? 'text-red-700 dark:text-red-300' : undefined} />
          <SummaryItem label={t('doc.missingPunchDays')} value={String(totals.missingPunchDays)} />
        </dl>
        <div className="mt-3 border-t pt-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('doc.leaveTaken')}</p>
          {totals.leaveByType.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('doc.noLeave')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {totals.leaveByType.map((l) => (
                <Badge key={l.code} variant="secondary" className="gap-1.5">
                  <span className="font-semibold">{l.code}</span>
                  <span>{snapshot.organization.locale === 'ar' && l.nameAr ? l.nameAr : l.name}</span>
                  <span className="tnum" dir="ltr">× {fmtDays(l.days)}</span>
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryItem({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:block">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('font-semibold tnum', className)} dir="ltr">
        {value}
        {hint ? <span className="ms-1 text-xs font-normal text-muted-foreground">({hint})</span> : null}
      </dd>
    </div>
  );
}

function fmtDays(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** A day row plus its optional editor row, keeping valid table markup. */
function FragmentRow({ children, extra }: { children: ReactNode; extra: ReactNode }) {
  if (!extra) return <>{children}</>;
  return (
    <>
      {children}
      <tr className="border-b bg-muted/10 last:border-0">
        <td colSpan={8} className="px-3 py-2">{extra}</td>
      </tr>
    </>
  );
}
