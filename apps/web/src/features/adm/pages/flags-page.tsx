import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Plus } from 'lucide-react';
import type { FeatureFlagDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, FormField, Input, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { usePlatformFeatureFlags } from '@/features/platform/api';
import { useAdmMutations } from '../api';

const newFlagSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  description: z.string().trim().min(1).max(300),
  rolloutPercentage: z.number().int().min(0).max(100),
});
type NewFlag = z.infer<typeof newFlagSchema>;

function NewFlagDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { putFlags } = useAdmMutations();
  const form = useForm<NewFlag>({ resolver: zodResolver(newFlagSchema), defaultValues: { key: '', description: '', rolloutPercentage: 0 } });
  const { register, formState: { errors } } = form;
  const submit = form.handleSubmit((v) => putFlags.mutate([{ ...v, defaultEnabled: false }], { onSuccess: () => { toast.success(t('flagsPage.saved')); onOpenChange(false); }, onError: toastError }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('flagsPage.addTitle')}</DialogTitle><DialogDescription>{t('flagsPage.subtitle')}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField label={t('flagsPage.key')} htmlFor="flag-key" required hint={t('flagsPage.keyHint')} error={errors.key?.message}>
            <Input id="flag-key" dir="ltr" className="font-mono" {...register('key')} aria-invalid={!!errors.key} />
          </FormField>
          <FormField label={t('flagsPage.description')} htmlFor="flag-description" required error={errors.description?.message}>
            <Input id="flag-description" {...register('description')} aria-invalid={!!errors.description} />
          </FormField>
          <FormField label={t('flagsPage.rollout')} htmlFor="flag-rollout" error={errors.rolloutPercentage?.message}>
            <Input id="flag-rollout" type="number" min={0} max={100} dir="ltr" {...register('rolloutPercentage', { valueAsNumber: true })} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={putFlags.isPending}>{tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RolloutInput({ flag, onSave, disabled }: { flag: FeatureFlagDto; onSave: (v: number) => void; disabled: boolean }) {
  const { t } = useTranslation('adm');
  const [value, setValue] = useState(String(flag.rolloutPercentage));
  const commit = () => { const n = Math.max(0, Math.min(100, Math.round(Number(value)))); if (Number.isFinite(n) && n !== flag.rolloutPercentage) onSave(n); else setValue(String(flag.rolloutPercentage)); };
  return <Input type="number" min={0} max={100} dir="ltr" className="h-8 w-20 tnum" value={value} disabled={disabled} aria-label={`${t('flagsPage.rollout')} ${flag.key}`} onChange={(e) => setValue(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />;
}

export default function AdmFlagsPage() {
  const { t } = useTranslation('adm');
  const q = usePlatformFeatureFlags();
  const { putFlags } = useAdmMutations();
  const [adding, setAdding] = useState(false);
  const save = (flag: Partial<FeatureFlagDto> & { key: string }) => putFlags.mutate([flag], { onSuccess: () => toast.success(t('flagsPage.saved')), onError: toastError });
  return (
    <div className="page-container">
      <PageHeader title={t('flagsPage.title')} description={t('flagsPage.subtitle')} actions={<Button size="sm" onClick={() => setAdding(true)}><Plus /> {t('flagsPage.add')}</Button>} />
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? <Skeleton className="m-4 h-40" /> : q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : (q.data?.length ?? 0) === 0 ? <p className="p-4 text-sm text-muted-foreground">{t('flagsPage.empty')}</p> : (
            <div className="overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>{t('flagsPage.key')}</TableHead><TableHead>{t('flagsPage.default')}</TableHead><TableHead>{t('flagsPage.rollout')}</TableHead><TableHead>{t('flagsPage.updated')}</TableHead></TableRow></TableHeader>
              <TableBody>{q.data?.map((f) => (
                <TableRow key={f.key}>
                  <TableCell><p className="font-mono text-sm" dir="ltr">{f.key}</p><p className="text-xs text-muted-foreground">{f.description}</p></TableCell>
                  <TableCell><Switch checked={f.defaultEnabled} disabled={putFlags.isPending} onCheckedChange={(v) => save({ key: f.key, defaultEnabled: v })} aria-label={`${t('flagsPage.default')} ${f.key}`} /></TableCell>
                  <TableCell><RolloutInput key={`${f.key}-${f.rolloutPercentage}`} flag={f} disabled={putFlags.isPending} onSave={(v) => save({ key: f.key, rolloutPercentage: v })} /></TableCell>
                  <TableCell className="text-xs tnum">{fmtRelative(f.updatedAt)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table></div>
          )}
        </CardContent>
      </Card>
      {adding ? <NewFlagDialog open onOpenChange={(v) => !v && setAdding(false)} /> : null}
    </div>
  );
}
