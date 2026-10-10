import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Check, Eye, MapPin, X } from 'lucide-react';
import type { SelfieCheckinDto, SelfieCheckinStatus } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Textarea } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { AR_NS } from '../i18n';
import { useSelfiePhoto, useSelfieReview, useSelfiesForReview } from '../api';

const STATUS_TONE: Record<SelfieCheckinStatus, 'warning' | 'success' | 'danger'> = { pending: 'warning', approved: 'success', rejected: 'danger' };

/** The photo of one selfie check-in: a short-lived signed URL fetched only when the dialog opens (each issue is audited). */
function SelfiePhotoDialog({ selfie, onClose, timezone }: { selfie: SelfieCheckinDto | null; onClose: () => void; timezone: string }) {
  const { t } = useTranslation(AR_NS);
  const photo = useSelfiePhoto(selfie?.id ?? null);
  return (
    <Dialog open={!!selfie} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('selfies.photoTitle', { name: selfie?.employeeName ?? '' })}</DialogTitle>
          <DialogDescription>{selfie ? fmtDateTime(selfie.punchedAt, timezone) : ''}</DialogDescription>
        </DialogHeader>
        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {photo.isLoading ? <Skeleton className="size-full" /> : photo.isError ? <p className="p-4 text-center text-sm text-muted-foreground">{t('selfies.photoUnavailable')}</p> : photo.data ? <img src={photo.data.url} alt={t('selfies.photoAlt', { name: selfie?.employeeName ?? '' })} className="size-full object-cover" /> : null}
        </div>
        {selfie?.latitude !== null && selfie?.latitude !== undefined ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground tnum" dir="ltr"><MapPin className="size-3.5" aria-hidden />{selfie.latitude.toFixed(5)}, {selfie.longitude?.toFixed(5)}{selfie.accuracyM ? ` ±${Math.round(selfie.accuracyM)} m` : ''}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

function RejectSelfieDialog({ selfie, onClose }: { selfie: SelfieCheckinDto | null; onClose: () => void }) {
  const { t } = useTranslation(AR_NS);
  const { t: tc } = useTranslation();
  const review = useSelfieReview();
  const [reason, setReason] = useState('');
  return (
    <Dialog open={!!selfie} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('selfies.rejectTitle')}</DialogTitle><DialogDescription>{t('selfies.rejectHint')}</DialogDescription></DialogHeader>
        <FormField label={t('selfies.reason')} htmlFor="selfie-reject-reason" required>
          <Textarea id="selfie-reject-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant="destructive" disabled={!reason.trim()} loading={review.isPending} onClick={() => { if (!selfie) return; review.mutate({ id: selfie.id, input: { decision: 'reject', reason: reason.trim() } }, { onSuccess: () => { toast.success(t('selfies.rejected')); onClose(); }, onError: toastError }); }}><X /> {t('selfies.reject')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Selfie check-ins waiting for a decision (line managers see their direct reports', HR the organisation's within its branch
 * scope). Approving records the punch at the time the selfie was taken; rejecting needs a reason the employee sees.
 */
export function SelfieReviewPanel() {
  const { t } = useTranslation(AR_NS);
  const tz = useOrgTimezone();
  const [status, setStatus] = useState<SelfieCheckinStatus>('pending');
  const q = useSelfiesForReview({ status, page: 1, pageSize: 50 });
  const review = useSelfieReview();
  const [viewing, setViewing] = useState<SelfieCheckinDto | null>(null);
  const [rejecting, setRejecting] = useState<SelfieCheckinDto | null>(null);
  const rows = q.data?.data ?? [];
  return (
    <div className="space-y-3" data-testid="selfie-review">
      <div className="inline-flex rounded-md border bg-card p-0.5 shadow-card" role="group" aria-label={t('selfies.filter')}>
        {(['pending', 'approved', 'rejected'] as const).map((s) => <Button key={s} size="sm" variant={s === status ? 'default' : 'ghost'} aria-pressed={s === status} onClick={() => setStatus(s)}>{t(`selfies.status.${s}`)}</Button>)}
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <TableSkeleton cols={6} rows={3} /> : rows.length === 0 ? <EmptyState icon={Camera} title={t('selfies.empty')} description={t('selfies.emptyHint')} /> : (
        <div className="rounded-xl border bg-card shadow-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>{(['employee', 'time', 'direction', 'location', 'status'] as const).map((c) => <TableHead key={c}>{t(`selfies.columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id} data-testid="selfie-review-row">
                    <TableCell><span className="font-medium">{s.employeeName ?? '—'}</span> <span className="font-mono text-xs text-muted-foreground" dir="ltr">{s.employeeNumber}</span>{s.viaManager === false ? <Badge variant="outline" className="ms-1.5 text-[10px]">{t('notes.oversightChip')}</Badge> : null}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs tnum">{fmtDateTime(s.punchedAt, tz, 'EEE dd MMM HH:mm')}</TableCell>
                    <TableCell className="text-xs">{t(`selfies.direction.${s.direction}`)}</TableCell>
                    <TableCell className="text-xs">{s.verdict ? t(`verdict.${s.verdict}`) : t('selfies.noLocation')}</TableCell>
                    <TableCell><Badge variant={STATUS_TONE[s.status]} dot>{t(`selfies.status.${s.status}`)}</Badge>{s.reviewReason ? <span className="block max-w-[200px] truncate text-xs text-muted-foreground" title={s.reviewReason}>{s.reviewReason}</span> : null}</TableCell>
                    <TableCell className="text-end">
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        {/* the API says what the caller may do (an API that predates the flags sends none: offer both) */}
                        {s.canViewPhoto !== false ? <Button size="sm" variant="ghost" onClick={() => setViewing(s)}><Eye /> {t('selfies.viewPhoto')}</Button> : null}
                        {s.status === 'pending' && s.canReview !== false ? <>
                          <Button size="sm" loading={review.isPending && review.variables?.id === s.id} onClick={() => review.mutate({ id: s.id, input: { decision: 'approve' } }, { onSuccess: () => toast.success(t('selfies.approved')), onError: toastError })}><Check /> {t('selfies.approve')}</Button>
                          <Button size="sm" variant="outline" onClick={() => setRejecting(s)}><X /> {t('selfies.reject')}</Button>
                        </> : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <SelfiePhotoDialog selfie={viewing} onClose={() => setViewing(null)} timezone={tz} />
      {rejecting ? <RejectSelfieDialog key={rejecting.id} selfie={rejecting} onClose={() => setRejecting(null)} /> : null}
    </div>
  );
}
