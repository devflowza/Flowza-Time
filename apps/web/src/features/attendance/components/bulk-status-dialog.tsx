import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks } from 'lucide-react';
import { BULK_STATUS_MAX_ITEMS, MANUAL_ATTENDANCE_STATUSES, type BulkStatusResultDto, type ManualAttendanceStatus } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import '../workspace-i18n';
import { useWorkspaceMutations } from '../workspace-api';

export interface BulkStatusItem { employeeId: string; date: string; employeeName?: string }

/**
 * Bulk "Set status" (HR portal Prompt 6a): one SET_STATUS correction per selected day with one reason. Items are independent —
 * a locked period or an employee outside the caller's scope is reported per row and the rest still go through.
 */
export function BulkStatusDialog({ items, onOpenChange, onDone }: { items: BulkStatusItem[] | null; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const { bulkStatus } = useWorkspaceMutations();
  const [status, setStatus] = useState<ManualAttendanceStatus | ''>('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<BulkStatusResultDto | null>(null);
  const open = !!items;
  const tooMany = (items?.length ?? 0) > BULK_STATUS_MAX_ITEMS;
  const valid = !!status && reason.trim().length >= 3 && !tooMany;
  const byKey = new Map((items ?? []).map((i) => [`${i.employeeId}|${i.date}`, i]));

  const submit = () => {
    setTouched(true);
    if (!items || !valid || !status) return;
    bulkStatus.mutate({ items: items.map(({ employeeId, date }) => ({ employeeId, date })), status, reason: reason.trim() }, {
      onSuccess: (res) => {
        setResult(res);
        if (res.failed === 0) { toast.success(t('bulk.done', { count: res.succeeded })); onDone?.(); onOpenChange(false); }
        else toast.warning(t('bulk.partial', { ok: res.succeeded, failed: res.failed }));
      },
      onError: toastError,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setResult(null); if (result && result.succeeded > 0) onDone?.(); } onOpenChange(o); }}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ListChecks className="size-4" /> {t('bulk.title')}</DialogTitle>
          <DialogDescription>{t('bulk.subtitle', { count: items?.length ?? 0 })}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-2" data-testid="bulk-result">
            <p className="text-sm">{t('bulk.partial', { ok: result.succeeded, failed: result.failed })}</p>
            <ul className="max-h-60 space-y-1 overflow-y-auto text-xs">
              {result.results.filter((r) => !r.ok).map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 rounded border px-2 py-1">
                  <span className="font-medium">{byKey.get(`${r.employeeId}|${r.date}`)?.employeeName ?? r.employeeId.slice(0, 8)}</span>
                  <span className="tnum">{fmtDate(r.date)}</span>
                  <Badge variant="danger" className="text-[10px]">{r.error?.code}</Badge>
                  <span className="text-muted-foreground">{r.error?.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-3">
            {tooMany ? <p className="text-sm text-destructive" role="alert">{t('bulk.tooMany', { max: BULK_STATUS_MAX_ITEMS })}</p> : null}
            <FormField label={t('bulk.status')} htmlFor="bulk-status" required error={touched && !status ? t('bulk.statusRequired') : undefined}>
              <Select value={status} onValueChange={(v) => setStatus(v as ManualAttendanceStatus)}>
                <SelectTrigger id="bulk-status" aria-label={t('bulk.status')}><SelectValue placeholder={t('bulk.pickStatus')} /></SelectTrigger>
                <SelectContent>{MANUAL_ATTENDANCE_STATUSES.map((s) => <SelectItem key={s} value={s}>{ta(`status.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label={t('edit.reason')} htmlFor="bulk-reason" required error={touched && reason.trim().length < 3 ? t('edit.reasonRequired') : undefined}>
              <Textarea id="bulk-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('edit.reasonPlaceholder')} aria-invalid={touched && reason.trim().length < 3} maxLength={1000} />
            </FormField>
            <p className="text-xs text-muted-foreground">{t('bulk.hint')}</p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{result ? tc('common.close') : tc('common.cancel')}</Button>
          {!result ? <Button type="button" onClick={submit} loading={bulkStatus.isPending}>{t('bulk.apply')}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
