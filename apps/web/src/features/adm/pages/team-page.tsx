import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { UserPlus } from 'lucide-react';
import { createPlatformAdminSchema, PLATFORM_ADMIN_LEVELS, type PlatformAdminDto, type PlatformAdminLevel } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useAdmMutations, usePlatformAdmins } from '../api';

type AddValues = z.input<typeof createPlatformAdminSchema>;

function AddAdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { addAdmin } = useAdmMutations();
  const form = useForm<AddValues>({ resolver: zodResolver(createPlatformAdminSchema), defaultValues: { email: '', level: 'support' } });
  const { register, control, formState: { errors } } = form;
  const submit = form.handleSubmit((v) => addAdmin.mutate({ email: v.email, level: v.level ?? 'support' }, { onSuccess: (a) => { toast.success(t('team.added', { email: a.email })); onOpenChange(false); }, onError: toastError }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('team.add')}</DialogTitle><DialogDescription>{t('team.addHint')}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField label={t('team.email')} htmlFor="admin-email" required error={errors.email?.message}>
            <Input id="admin-email" type="email" dir="ltr" autoComplete="off" {...register('email')} aria-invalid={!!errors.email} />
          </FormField>
          <FormField label={t('team.level')} htmlFor="admin-level" hint={t('team.levelHint')}>
            <Controller control={control} name="level" render={({ field }) => (
              <Select value={field.value ?? 'support'} onValueChange={field.onChange}><SelectTrigger id="admin-level"><SelectValue /></SelectTrigger>
                <SelectContent>{PLATFORM_ADMIN_LEVELS.map((l) => <SelectItem key={l} value={l}>{t(`levels.${l}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={addAdmin.isPending}><UserPlus /> {t('team.add')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdmTeamPage() {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const q = usePlatformAdmins();
  const { updateAdmin } = useAdmMutations();
  const [adding, setAdding] = useState(false);
  const [disabling, setDisabling] = useState<PlatformAdminDto | null>(null);
  const self = q.data?.find((a) => a.isSelf);
  const canManage = self?.level === 'owner' && self.status === 'active';
  const update = (a: PlatformAdminDto, input: { level?: PlatformAdminLevel; status?: 'active' | 'disabled' }, done?: () => void) =>
    updateAdmin.mutate({ userId: a.userId, input }, { onSuccess: () => { toast.success(t('team.updated')); done?.(); }, onError: toastError });
  return (
    <div className="page-container">
      <PageHeader title={t('team.title')} description={t('team.subtitle')} actions={<Button size="sm" onClick={() => setAdding(true)} disabled={!canManage} title={!canManage ? t('team.ownerOnly') : undefined}><UserPlus /> {t('team.add')}</Button>} />
      {!canManage && q.data ? <p className="mb-3 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('team.ownerOnly')}</p> : null}
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? <Skeleton className="m-4 h-40" /> : q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : (
            <div className="overflow-x-auto"><Table>
              <TableHeader><TableRow>
                <TableHead>{t('users.name')}</TableHead><TableHead>{t('team.level')}</TableHead><TableHead>{tc('common.status')}</TableHead><TableHead>{t('users.mfa')}</TableHead>
                <TableHead>{t('users.lastLogin')}</TableHead><TableHead>{t('team.grantedBy')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead>
              </TableRow></TableHeader>
              <TableBody>{(q.data ?? []).map((a) => {
                const locked = !canManage || a.isSelf;
                return (
                  <TableRow key={a.userId}>
                    <TableCell><p className="font-medium">{a.fullName || a.email} {a.isSelf ? <Badge variant="outline" className="ms-1 font-normal">{t('team.you')}</Badge> : null}</p><p className="text-xs text-muted-foreground" dir="ltr">{a.email}</p></TableCell>
                    <TableCell>
                      <Select value={a.level} disabled={locked || updateAdmin.isPending} onValueChange={(v) => update(a, { level: v as PlatformAdminLevel })}>
                        <SelectTrigger className="h-8 w-32" aria-label={t('team.level')} title={a.isSelf ? t('team.selfLocked') : !canManage ? t('team.ownerOnly') : undefined}><SelectValue /></SelectTrigger>
                        <SelectContent>{PLATFORM_ADMIN_LEVELS.map((l) => <SelectItem key={l} value={l}>{t(`levels.${l}`)}</SelectItem>)}</SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell><Badge variant={a.status === 'active' ? 'success' : 'neutral'}>{t(`team.statuses.${a.status}`)}</Badge></TableCell>
                    <TableCell>{a.mfaEnrolled ? <Badge variant="success">{t('mfaOn')}</Badge> : <Badge variant="danger">{t('mfaOff')}</Badge>}</TableCell>
                    <TableCell className="text-xs tnum">{a.lastLoginAt ? fmtRelative(a.lastLoginAt) : t('members.never')}</TableCell>
                    <TableCell className="text-xs"><span dir="ltr">{a.grantedByEmail ?? '—'}</span><span className="block text-muted-foreground tnum">{t('team.since')} {fmtDateTime(a.createdAt, 'UTC', 'dd MMM yyyy')}</span></TableCell>
                    <TableCell className="text-end">
                      {a.status === 'active'
                        ? <Button size="sm" variant="outline" className="text-destructive" disabled={locked} onClick={() => setDisabling(a)}>{t('team.disable')}</Button>
                        : <Button size="sm" variant="outline" disabled={locked || updateAdmin.isPending} onClick={() => update(a, { status: 'active' })}>{t('team.enable')}</Button>}
                    </TableCell>
                  </TableRow>
                );
              })}</TableBody>
            </Table></div>
          )}
        </CardContent>
      </Card>
      {adding ? <AddAdminDialog open onOpenChange={(v) => !v && setAdding(false)} /> : null}
      {disabling ? (
        <ConfirmDialog open onOpenChange={(v) => !v && setDisabling(null)} title={t('team.disableTitle', { email: disabling.email })} description={t('team.disableHint')}
          confirmLabel={t('team.disable')} destructive loading={updateAdmin.isPending} onConfirm={() => update(disabling, { status: 'disabled' }, () => setDisabling(null))} />
      ) : null}
    </div>
  );
}
