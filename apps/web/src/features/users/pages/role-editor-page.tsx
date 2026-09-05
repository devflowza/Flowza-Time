import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Info, Lock, Trash2 } from 'lucide-react';
import { roleInputSchema, updateRoleSchema, type Permission, type RoleDto, type RoleInput, type UpdateRoleInput } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, ConfirmDialog, EmptyState, ErrorState, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useActiveMembership, useCan } from '@/features/me/use-me';
import { usePermissions, useRoleMutations, useRoles } from '../api';
import { PermissionMatrix } from '../components/permission-matrix';

type CreateValues = z.input<typeof roleInputSchema>;
type UpdateValues = z.input<typeof updateRoleSchema>;

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 64);

export default function RoleEditorPage() {
  const { t } = useTranslation('users');
  const { id = '' } = useParams();
  const roles = useRoles();
  const perms = usePermissions();
  if (roles.isLoading || perms.isLoading) return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-96 w-full" /></div>;
  if (roles.isError) return <div className="page-container"><ErrorState error={roles.error} onRetry={() => void roles.refetch()} /></div>;
  if (perms.isError) return <div className="page-container"><ErrorState error={perms.error} onRetry={() => void perms.refetch()} /></div>;
  if (id === 'new') return <CreateRole />;
  const role = roles.data?.find((r) => r.id === id);
  if (!role) return <div className="page-container"><EmptyState title={t('roles.notFound')} action={<Button asChild variant="outline"><Link to="/users?tab=roles">{t('tabs.roles')}</Link></Button>} /></div>;
  return <EditRole key={role.updatedAt} role={role} />;
}

function Breadcrumb() {
  const { t } = useTranslation('users');
  return <Link to="/users?tab=roles" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('tabs.roles')}</Link>;
}

function GrantHint() {
  const { t } = useTranslation('users');
  return <p className="flex items-start gap-2 rounded-md border bg-accent/50 p-3 text-sm"><Info className="mt-0.5 size-4 shrink-0 text-brand-700" /> {t('roles.grantHint')}</p>;
}

function CreateRole() {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const me = useActiveMembership();
  const perms = usePermissions();
  const { create } = useRoleMutations();
  const grantable = new Set(me?.permissions ?? []);
  const [keyTouched, setKeyTouched] = useState(false);
  const form = useForm<CreateValues, unknown, RoleInput>({ resolver: zodResolver(roleInputSchema), defaultValues: { key: '', name: '', description: '', permissions: [] } });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const onSubmit = form.handleSubmit(async (values) => {
    try { const r = await create.mutateAsync({ ...values, description: values.description || undefined }); toast.success(t('roles.created', { name: r.name })); navigate(`/users/roles/${r.id}`); } catch (e) { toastError(e); }
  });
  return (
    <div className="page-container">
      <PageHeader title={t('roles.create')} description={t('roles.createHint')} breadcrumbs={<Breadcrumb />} />
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <Card><CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
          <FormField label={tc('common.name')} htmlFor="role-name" required error={errors.name?.message}>
            <Input id="role-name" {...register('name', { onChange: (e) => { if (!keyTouched) setValue('key', slug(e.target.value)); } })} aria-invalid={!!errors.name} />
          </FormField>
          <FormField label={t('roles.key')} htmlFor="role-key" required error={errors.key?.message} hint={t('roles.keyHint')}>
            <Input id="role-key" dir="ltr" className="font-mono" {...register('key', { onChange: () => setKeyTouched(true) })} aria-invalid={!!errors.key} />
          </FormField>
          <FormField label={t('roles.description')} htmlFor="role-desc" optional error={errors.description?.message} className="sm:col-span-2">
            <Textarea id="role-desc" maxLength={300} {...register('description')} />
          </FormField>
        </CardContent></Card>
        <GrantHint />
        {errors.permissions ? <p role="alert" className="text-sm text-destructive">{t('roles.permissionsRequired')}</p> : null}
        <Controller control={control} name="permissions" render={({ field }) => <PermissionMatrix permissions={perms.data ?? []} value={field.value ?? []} onChange={(next: Permission[]) => field.onChange(next)} grantable={grantable} />} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => navigate('/users?tab=roles')}>{tc('common.cancel')}</Button>
          <Button type="submit" loading={isSubmitting}>{t('roles.create')}</Button>
        </div>
      </form>
    </div>
  );
}

function EditRole({ role }: { role: RoleDto }) {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const me = useActiveMembership();
  const perms = usePermissions();
  const { update, remove } = useRoleMutations();
  const readOnly = role.isSystem || !can('role.manage');
  const grantable = new Set(me?.permissions ?? []);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const form = useForm<UpdateValues, unknown, UpdateRoleInput>({ resolver: zodResolver(updateRoleSchema), defaultValues: { name: role.name, description: role.description ?? '', permissions: role.permissions as Permission[] }, disabled: readOnly });
  const { register, control, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => {
    try { await update.mutateAsync({ id: role.id, input: { ...values, description: values.description === '' ? null : values.description } }); toast.success(t('roles.updated', { name: role.name })); } catch (e) { toastError(e); }
  });
  return (
    <div className="page-container">
      <PageHeader title={role.name} description={role.description ?? undefined} breadcrumbs={<Breadcrumb />} actions={
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono" dir="ltr">{role.key}</Badge>
          {role.isSystem ? <Badge variant="neutral"><Lock className="size-3" /> {t('roles.systemReadOnly')}</Badge> : <Badge variant="info">{t('roles.custom')}</Badge>}
          {role.memberCount !== undefined ? <Badge variant="secondary">{t('roles.memberCount', { count: role.memberCount })}</Badge> : null}
          {!role.isSystem && can('role.manage') ? <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}><Trash2 /> {tc('common.delete')}</Button> : null}
        </div>
      } />
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {!role.isSystem ? (
          <Card><CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
            <FormField label={tc('common.name')} htmlFor="role-name" required error={errors.name?.message}><Input id="role-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
            <FormField label={t('roles.description')} htmlFor="role-desc" optional error={errors.description?.message}><Textarea id="role-desc" maxLength={300} {...register('description')} /></FormField>
          </CardContent></Card>
        ) : null}
        {!readOnly ? <GrantHint /> : null}
        {errors.permissions ? <p role="alert" className="text-sm text-destructive">{t('roles.permissionsRequired')}</p> : null}
        <Controller control={control} name="permissions" render={({ field }) => <PermissionMatrix permissions={perms.data ?? []} value={field.value ?? []} onChange={(next: Permission[]) => field.onChange(next)} readOnly={readOnly} grantable={grantable} />} />
        {!readOnly ? (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={!isDirty} onClick={() => form.reset()}>{t('roles.discard')}</Button>
            <Button type="submit" loading={isSubmitting} disabled={!isDirty}>{tc('common.save')}</Button>
          </div>
        ) : null}
      </form>
      <ConfirmDialog open={deleting} onOpenChange={(o) => { setDeleting(o); if (!o) setDeleteError(null); }} title={t('roles.deleteTitle', { name: role.name })} description={t('roles.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => remove.mutate(role.id, { onSuccess: () => { toast.success(t('roles.deleted')); navigate('/users?tab=roles'); }, onError: (e) => setDeleteError(e instanceof Error ? e.message : t('roles.deleteFailed')) })}>
        {deleteError ? <p role="alert" className="rounded-md border border-destructive/30 bg-red-50 p-2 text-sm text-destructive dark:bg-red-950/30">{deleteError}</p> : null}
      </ConfirmDialog>
    </div>
  );
}
