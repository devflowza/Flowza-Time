import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, MessageSquare, MessageSquareReply, Send } from 'lucide-react';
import type { LeaveCommentDto } from '@flowza/contracts';
import { Button, EmptyState, ErrorState, Label, Skeleton, Textarea } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { useAddLeaveComment, useLeaveComments } from '../api';

const KIND_STYLE: Record<LeaveCommentDto['kind'], string> = {
  comment: 'bg-card',
  info_request: 'border-indigo-300 bg-indigo-50 text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100',
  reply: 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/30',
  system: 'border-dashed bg-muted/30 text-muted-foreground',
};

/**
 * The comment thread of a leave request (append-only; read by everyone who can read the leave or its approval request —
 * the employee, the approvers, HR). `reply`: while an approver's question is open, the employee's message answers it through
 * the approval engine (POST /me/leave/:id/reply: the request goes back to PENDING) instead of being a plain comment.
 */
export function LeaveThread({ leaveId, canComment = true, reply }: { leaveId: string; canComment?: boolean; reply?: { onSubmit: (body: string) => Promise<unknown>; pending: boolean } }) {
  const { t } = useTranslation('leave');
  const tz = useOrgTimezone();
  const q = useLeaveComments(leaveId);
  const add = useAddLeaveComment(leaveId);
  const [body, setBody] = useState('');
  const text = body.trim();
  const busy = reply ? reply.pending : add.isPending;
  const submit = async () => {
    if (!text) return;
    try {
      if (reply) { await reply.onSubmit(text); toast.success(t('thread.replied')); }
      else { await add.mutateAsync(text); toast.success(t('thread.posted')); }
      setBody('');
    } catch (e) { toastError(e); }
  };
  return (
    <section className="space-y-3" aria-label={t('thread.title')}>
      <h4 className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="size-4" aria-hidden /> {t('thread.title')}</h4>
      {q.isLoading ? <Skeleton className="h-20 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={MessageSquare} title={t('thread.empty')} description={t('thread.emptyHint')} className="py-4" />
      ) : (
        <ol className="max-h-80 space-y-2 overflow-y-auto pe-1">
          {q.data.map((c) => (
            <li key={c.id} className={cn('rounded-md border p-2.5 text-sm', KIND_STYLE[c.kind], c.mine && c.kind === 'comment' && 'border-primary/30')} data-kind={c.kind}>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-medium">
                  {c.kind === 'info_request' ? <HelpCircle className="size-3.5" aria-hidden /> : c.kind === 'reply' ? <MessageSquareReply className="size-3.5" aria-hidden /> : null}
                  {c.kind === 'system' ? t('thread.system') : c.mine ? t('thread.you') : c.authorName ?? t('thread.someone')}
                  {c.kind === 'info_request' ? <span className="font-normal">· {t('thread.kind.info_request')}</span> : c.kind === 'reply' ? <span className="font-normal">· {t('thread.kind.reply')}</span> : null}
                </span>
                <time className="tnum text-muted-foreground" dateTime={c.createdAt}>{fmtDateTime(c.createdAt, tz)}</time>
              </div>
              <p className="whitespace-pre-wrap break-words" dir="auto">{c.body}</p>
            </li>
          ))}
        </ol>
      )}
      {canComment || reply ? (
        <div className="space-y-2">
          <Label htmlFor={`leave-thread-${leaveId}`}>{reply ? t('thread.replyLabel') : t('thread.commentLabel')}</Label>
          <Textarea id={`leave-thread-${leaveId}`} rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={reply ? t('thread.replyPlaceholder') : t('thread.placeholder')} />
          <div className="flex justify-end"><Button size="sm" type="button" disabled={!text} loading={busy} onClick={() => void submit()}>{reply ? <MessageSquareReply /> : <Send />} {reply ? t('thread.reply') : t('thread.post')}</Button></div>
        </div>
      ) : null}
    </section>
  );
}
