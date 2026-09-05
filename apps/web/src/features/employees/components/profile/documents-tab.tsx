import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { FileText, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { IDENTITY_DOCUMENT_TYPES, identityDocumentInputSchema, type IdentityDocumentDto } from '@flowza/contracts';
import type { z } from 'zod';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@/components/ui';
import { fmtDate, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useEmployeeDocuments, useEmployeeMutations, type IdentityDocumentInput } from '../../api';

type Output = z.output<typeof identityDocumentInputSchema>;

export function DocumentsTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const can = useCan();
  const tz = useOrgTimezone();
  const canView = can('employee.view_sensitive');
  const canEdit = canView && can('employee.update');
  const q = useEmployeeDocuments(employeeId, canView);
  const { addDocument, deleteDocument } = useEmployeeMutations();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<IdentityDocumentDto | null>(null);
  const today = todayIso(tz);

  if (!canView) return <EmptyState icon={ShieldAlert} title={t('documents.restricted')} description={t('documents.restrictedHint')} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('documents.auditNotice')}</p>
        {canEdit ? <Button size="sm" onClick={() => setAdding(true)}><Plus /> {t('documents.add')}</Button> : null}
      </div>
      {q.isLoading ? <Skeleton className="h-40 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data || q.data.length === 0 ? (
        <EmptyState icon={FileText} title={t('documents.empty')} description={t('documents.emptyHint')} action={canEdit ? <Button size="sm" onClick={() => setAdding(true)}><Plus /> {t('documents.add')}</Button> : undefined} />
      ) : (
        <div className="rounded-lg border bg-card shadow-card">
          <Table>
            <TableHeader><TableRow><TableHead>{t('documents.type')}</TableHead><TableHead>{t('documents.number')}</TableHead><TableHead>{t('documents.country')}</TableHead><TableHead>{t('documents.issued')}</TableHead><TableHead>{t('documents.expires')}</TableHead><TableHead>{t('documents.notes')}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {q.data.map((d) => {
                const expired = !!d.expiresAt && d.expiresAt < today;
                const soon = !!d.expiresAt && !expired && d.expiresAt <= todayPlusDays(today, 60);
                return (
                  <TableRow key={d.id}>
                    <TableCell><Badge variant="secondary">{t(`documents.types.${d.type}`)}</Badge></TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">{d.number}</TableCell>
                    <TableCell dir="ltr">{d.issuingCountry ?? '—'}</TableCell>
                    <TableCell className="tnum">{fmtDate(d.issuedAt)}</TableCell>
                    <TableCell className="tnum"><span className="inline-flex items-center gap-2">{fmtDate(d.expiresAt)}{expired ? <Badge variant="danger">{t('documents.expired')}</Badge> : soon ? <Badge variant="warning">{t('documents.expiringSoon')}</Badge> : null}</span></TableCell>
                    <TableCell className="max-w-[240px] truncate text-muted-foreground">{d.notes ?? '—'}</TableCell>
                    <TableCell className="text-end">{canEdit ? <Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label={tc('common.delete')} onClick={() => setDeleting(d)}><Trash2 /></Button> : null}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {adding ? <AddDocumentDialog employeeId={employeeId} onClose={() => setAdding(false)} onSave={(input) => addDocument.mutateAsync({ id: employeeId, input }).then(() => { toast.success(t('documents.added')); setAdding(false); }).catch(toastError)} loading={addDocument.isPending} /> : null}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('documents.deleteTitle')} description={t('documents.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={deleteDocument.isPending}
        onConfirm={() => deleting && deleteDocument.mutate({ id: employeeId, documentId: deleting.id }, { onSuccess: () => { toast.success(t('documents.deleted')); setDeleting(null); }, onError: toastError })} />
    </div>
  );
}

function todayPlusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}

function AddDocumentDialog({ onClose, onSave, loading }: { employeeId: string; onClose: () => void; onSave: (input: IdentityDocumentInput) => Promise<unknown>; loading: boolean }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const form = useForm<IdentityDocumentInput, unknown, Output>({ resolver: zodResolver(identityDocumentInputSchema), defaultValues: { type: 'civil_id', number: '' } });
  const { register, control, formState: { errors } } = form;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('documents.add')}</DialogTitle><DialogDescription>{t('documents.addHint')}</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => onSave(v))} className="space-y-4" noValidate>
          <FormField label={t('documents.type')} htmlFor="doc-type" required>
            <Controller control={control} name="type" render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="doc-type"><SelectValue /></SelectTrigger><SelectContent>{IDENTITY_DOCUMENT_TYPES.map((x) => <SelectItem key={x} value={x}>{t(`documents.types.${x}`)}</SelectItem>)}</SelectContent></Select>
            )} />
          </FormField>
          <FormField label={t('documents.number')} htmlFor="doc-number" required error={errors.number?.message}>
            <Input id="doc-number" dir="ltr" className="font-mono" autoComplete="off" {...register('number')} aria-invalid={!!errors.number} />
          </FormField>
          <FormField label={t('documents.country')} htmlFor="doc-country" optional error={errors.issuingCountry?.message}>
            <Input id="doc-country" dir="ltr" maxLength={2} className="uppercase" {...register('issuingCountry', { setValueAs: blankToUndefined })} aria-invalid={!!errors.issuingCountry} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('documents.issued')} htmlFor="doc-issued" optional error={errors.issuedAt?.message}><Input id="doc-issued" type="date" dir="ltr" {...register('issuedAt', { setValueAs: blankToUndefined })} /></FormField>
            <FormField label={t('documents.expires')} htmlFor="doc-expires" optional error={errors.expiresAt?.message}><Input id="doc-expires" type="date" dir="ltr" {...register('expiresAt', { setValueAs: blankToUndefined })} /></FormField>
          </div>
          <FormField label={t('documents.notes')} htmlFor="doc-notes" optional error={errors.notes?.message}><Textarea id="doc-notes" maxLength={500} {...register('notes', { setValueAs: blankToUndefined })} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={loading}>{tc('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
