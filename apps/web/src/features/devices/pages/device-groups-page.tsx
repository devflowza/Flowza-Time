import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ArrowLeft, FolderKanban, Pencil, Plus, Trash2, X } from 'lucide-react';
import { deviceGroupInputSchema, type DeviceGroupDto, type DeviceGroupInput } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, EmptyState, ErrorState, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { blankToNull } from '@/features/organization/form-utils';
import { useDeviceGroups, useDeviceOptions, useDevices, useGroupMutations } from '../api';
import { ConnectionBadge } from '../components/device-badges';

type Values = z.input<typeof deviceGroupInputSchema>;
const COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#64748b'];

function GroupDialog({ group, open, onOpenChange }: { group: DeviceGroupDto | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const branches = useBranchOptions();
  const { create, update } = useGroupMutations();
  const form = useForm<Values, unknown, DeviceGroupInput>({ resolver: zodResolver(deviceGroupInputSchema), defaultValues: { name: group?.name ?? '', description: group?.description ?? null, branchId: group?.branchId ?? null, color: group?.color ?? COLORS[0] } });
  const { register, control, formState: { errors } } = form;
  const submit = form.handleSubmit((values) => {
    const done = (msg: string) => { toast.success(msg); onOpenChange(false); };
    if (group) update.mutate({ id: group.id, input: values }, { onSuccess: () => done(t('groups.updated')), onError: toastError });
    else create.mutate(values, { onSuccess: () => done(t('groups.created')), onError: toastError });
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{group ? t('groups.edit') : t('groups.add')}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField label={tc('common.name')} htmlFor="grp-name" required error={errors.name?.message}><Input id="grp-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
          <FormField label={t('groups.description')} htmlFor="grp-desc" optional error={errors.description?.message}><Textarea id="grp-desc" rows={2} {...register('description', { setValueAs: blankToNull })} /></FormField>
          <FormField label={tc('common.branch')} htmlFor="grp-branch" optional hint={t('bulk.assign-group.hint')} error={errors.branchId?.message}>
            <Controller control={control} name="branchId" render={({ field }) => <Combobox id="grp-branch" value={field.value ?? null} onChange={(v) => field.onChange(v)} options={branches.options} loading={branches.isLoading} clearable placeholder={t('groups.anyBranch')} />} />
          </FormField>
          <FormField label={t('groups.color')} htmlFor="grp-color" optional>
            <Controller control={control} name="color" render={({ field }) => (
              <div id="grp-color" role="radiogroup" aria-label={t('groups.color')} className="flex flex-wrap gap-2">
                {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={field.value === c} aria-label={c} onClick={() => field.onChange(c)} className={cn('size-7 rounded-full border-2 transition-transform focus-visible:ring-2 focus-visible:ring-ring', field.value === c ? 'scale-110 border-foreground' : 'border-transparent')} style={{ backgroundColor: c }} />)}
              </div>
            )} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending || update.isPending}>{group ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupMembers({ group }: { group: DeviceGroupDto }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const members = useDevices({ pageSize: 200, sort: 'name', groupId: group.id });
  const candidates = useDeviceOptions(group.branchId);
  const { addMembers, removeMembers } = useGroupMutations();
  const [adding, setAdding] = useState<string | null>(null);
  const memberIds = useMemo(() => new Set((members.data?.data ?? []).map((d) => d.id)), [members.data]);
  const options = useMemo(() => candidates.options.filter((o) => !memberIds.has(o.value)), [candidates.options, memberIds]);
  const manage = can('device.manage');
  const add = () => { if (!adding) return; addMembers.mutate({ id: group.id, deviceIds: [adding] }, { onSuccess: () => { toast.success(t('groups.membersUpdated')); setAdding(null); }, onError: toastError }); };
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2"><span className="size-3 rounded-full" style={{ backgroundColor: group.color ?? '#64748b' }} aria-hidden /> {group.name}</CardTitle>
          <CardDescription>{group.description || (group.branchName ? `${t('groups.branchBound')} · ${group.branchName}` : t('groups.anyBranch'))}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(`/devices?groupId=${group.id}`)}>{t('groups.viewDevices')}</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {manage ? (
          <div className="flex flex-wrap items-end gap-2">
            <FormField label={t('groups.addMember')} htmlFor="grp-add" className="min-w-[240px] flex-1">
              <Combobox id="grp-add" value={adding} onChange={setAdding} options={options} loading={candidates.isLoading} placeholder={t('groups.selectDevice')} emptyText={t('groups.allDevicesAdded')} />
            </FormField>
            <Button onClick={add} disabled={!adding} loading={addMembers.isPending}><Plus /> {tc('common.add')}</Button>
          </div>
        ) : null}
        {members.isLoading ? <Skeleton className="h-24 w-full" /> : members.isError ? <ErrorState error={members.error} onRetry={() => void members.refetch()} />
          : (members.data?.data.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('groups.noMembers')}</p> : (
            <ul className="divide-y rounded-md border">
              {members.data?.data.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <Link to={`/devices/${d.id}`} className="min-w-0 flex-1 hover:underline"><span className="font-medium">{d.name}</span> <span className="font-mono text-xs text-muted-foreground" dir="ltr">{d.code}</span></Link>
                  <span className="text-xs text-muted-foreground">{d.branchName ?? '—'}</span>
                  <ConnectionBadge status={d.connectionStatus} showRelative={false} />
                  {manage ? <Button variant="ghost" size="icon" aria-label={t('groups.removeMember')} onClick={() => removeMembers.mutate({ id: group.id, deviceIds: [d.id] }, { onSuccess: () => toast.success(t('groups.membersUpdated')), onError: toastError })} disabled={removeMembers.isPending}><X /></Button> : null}
                </li>
              ))}
            </ul>
          )}
      </CardContent>
    </Card>
  );
}

export default function DeviceGroupsPage() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const can = useCan();
  const q = useDeviceGroups();
  const { remove } = useGroupMutations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ open: boolean; group: DeviceGroupDto | null }>({ open: false, group: null });
  const [deleting, setDeleting] = useState<DeviceGroupDto | null>(null);
  const groups = q.data ?? [];
  // Derived: the explicitly selected group, else the first one (no effect needed).
  const selected = groups.find((g) => g.id === selectedId) ?? groups[0] ?? null;
  const manage = can('device.manage');

  return (
    <div className="page-container">
      <PageHeader
        breadcrumbs={<Link to="/devices" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>}
        title={t('groups.title')} description={t('groups.subtitle')}
        actions={manage ? <Button size="sm" onClick={() => setEditing({ open: true, group: null })}><Plus /> {t('groups.add')}</Button> : undefined}
      />
      {q.isLoading ? <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-64" /><Skeleton className="h-64 lg:col-span-2" /></div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : groups.length === 0 ? <EmptyState icon={FolderKanban} title={t('groups.empty')} description={t('groups.emptyHint')} action={manage ? <Button onClick={() => setEditing({ open: true, group: null })}><Plus /> {t('groups.add')}</Button> : undefined} />
        : (
          <div className="grid gap-4 lg:grid-cols-3">
            <ul className="space-y-2" aria-label={t('groups.title')}>
              {groups.map((g) => (
                <li key={g.id}>
                  <div className={cn('flex items-center gap-3 rounded-lg border bg-card p-3 shadow-card transition-colors', selected?.id === g.id ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-brand-300')}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-start" onClick={() => setSelectedId(g.id)} aria-current={selected?.id === g.id ? 'true' : undefined}>
                      <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: g.color ?? '#64748b' }} aria-hidden />
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{g.name}</span><span className="block truncate text-xs text-muted-foreground">{g.branchName ?? t('groups.anyBranch')}</span></span>
                      <Badge variant="secondary" className="tnum">{t('groups.members', { count: g.deviceCount })}</Badge>
                    </button>
                    {manage ? <>
                      <Button variant="ghost" size="icon" aria-label={t('groups.edit')} onClick={() => setEditing({ open: true, group: g })}><Pencil /></Button>
                      <Button variant="ghost" size="icon" aria-label={t('groups.delete')} className="text-destructive" onClick={() => setDeleting(g)}><Trash2 /></Button>
                    </> : null}
                  </div>
                </li>
              ))}
              <li className="px-1 text-xs text-muted-foreground tnum">{tc('common.results', { count: fmtNumber(groups.length) })}</li>
            </ul>
            <div className="lg:col-span-2">{selected ? <GroupMembers key={selected.id} group={selected} /> : null}</div>
          </div>
        )}
      {editing.open ? <GroupDialog key={editing.group?.id ?? 'new'} group={editing.group} open onOpenChange={(o) => !o && setEditing({ open: false, group: null })} /> : null}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={deleting ? `${t('groups.delete')}: ${deleting.name}` : ''} description={t('groups.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('groups.deleted')); setDeleting(null); if (selectedId === deleting.id) setSelectedId(null); }, onError: toastError }); }} />
    </div>
  );
}
