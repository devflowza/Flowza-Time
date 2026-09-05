import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, GitBranch, Pencil, Plus, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useRoles } from '@/features/users/api';
import { useWorkflowMutations, useWorkflows, type WorkflowDto } from '../api';
import { WorkflowDialog } from '../components/workflow-dialog';

/** /approvals/workflows — approval routing rules (steps builder). Editing requires organization.manage. */
export default function WorkflowsPage() {
  const { t } = useTranslation('approvals');
  const { t: tc } = useTranslation();
  const can = useCan();
  const canManage = can('organization.manage');
  const q = useWorkflows();
  const branches = useBranchOptions();
  const roles = useRoles();
  const { remove } = useWorkflowMutations();
  const [dialog, setDialog] = useState<{ open: boolean; workflow: WorkflowDto | null }>({ open: false, workflow: null });
  const [deleting, setDeleting] = useState<WorkflowDto | null>(null);
  const roleName = (id?: string) => roles.data?.find((r) => r.id === id)?.name ?? id?.slice(0, 8) ?? '—';

  return (
    <div className="page-container">
      <PageHeader title={t('workflows.title')} description={t('workflows.subtitle')} breadcrumbs={<Link to="/approvals" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>}
        actions={canManage ? <Button size="sm" onClick={() => setDialog({ open: true, workflow: null })}><Plus /> {t('workflows.add')}</Button> : undefined} />
      {q.isLoading ? <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : !q.data || q.data.length === 0 ? <EmptyState icon={GitBranch} title={t('workflows.empty')} description={t('workflows.emptyHint')} action={canManage ? <Button onClick={() => setDialog({ open: true, workflow: null })}><Plus /> {t('workflows.add')}</Button> : undefined} />
        : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {q.data.map((w) => (
              <Card key={w.id} className={w.status !== 'active' ? 'opacity-70' : undefined}>
                <CardHeader className="flex-row items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="flex flex-wrap items-center gap-2"><span className="truncate">{w.name}</span>{w.isDefault ? <Badge variant="info">{t('workflows.default')}</Badge> : null}{w.status !== 'active' ? <Badge variant="neutral">{t(`recordStatus.${w.status}`, { defaultValue: w.status })}</Badge> : null}</CardTitle>
                    <CardDescription>{t(`entity.${w.entityType}`, { defaultValue: w.entityType })} · {w.branchId ? branches.byId.get(w.branchId)?.name ?? w.branchId.slice(0, 8) : t('workflows.allBranches')}</CardDescription>
                  </div>
                  {canManage ? <div className="flex shrink-0 gap-1"><Button variant="ghost" size="icon" className="size-8" aria-label={tc('common.edit')} onClick={() => setDialog({ open: true, workflow: w })}><Pencil /></Button><Button variant="ghost" size="icon" className="size-8 text-destructive" aria-label={tc('common.delete')} onClick={() => setDeleting(w)}><Trash2 /></Button></div> : null}
                </CardHeader>
                <CardContent>
                  <ol className="space-y-1.5">
                    {w.steps.map((s, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm"><Badge variant="outline" className="tnum">{i + 1}</Badge><span className="font-medium">{t(`approverType.${s.approverType}`)}</span>{s.approverType === 'ROLE' ? <span className="text-muted-foreground">· {roleName(s.roleId)}</span> : s.approverType === 'USER' ? <span className="font-mono text-xs text-muted-foreground" dir="ltr">· {s.userId?.slice(0, 8)}…</span> : null}</li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      <WorkflowDialog key={`${dialog.open}-${dialog.workflow?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} workflow={dialog.workflow} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('workflows.deleteTitle', { name: deleting?.name ?? '' })} description={t('workflows.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('workflows.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
