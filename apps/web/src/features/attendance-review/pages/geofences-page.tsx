import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Lock, MapPinned, Pencil, Plus, Trash2, Users } from 'lucide-react';
import type { GeofenceDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useBranchOptions } from '@/features/organization/lookups';
import { AR_NS } from '../i18n';
import { useGeofenceMutations, useGeofences } from '../api';
import { GeofenceDialog } from '../components/geofence-dialog';
import { GeofenceAssignmentsDialog } from '../components/geofence-assignments';
import { GeofenceTester } from '../components/geofence-tester';

const ENFORCEMENT_TONE = { hard_block: 'danger', soft_warn: 'warning', advisory_log: 'info' } as const;

/**
 * /attendance/geofences — the work zones portal punches are checked against (attendance.manage_geofences): the list, create /
 * edit, who each zone applies to, and a dry-run tester. Which zone judges a punch (ATT-63/64) is stated on the page: the most
 * specific scope that applies wins, and within it the worst verdict decides. A zone the caller may not change (another
 * branch's, an organisation-wide one for a branch-scoped manager, or one that also applies to people outside their branches —
 * the API's `editable`, HR portal Prompt 4 review P0-1) is shown read-only, with the reason.
 */
export default function GeofencesPage() {
  const { t } = useTranslation(AR_NS);
  const q = useGeofences(true);
  const branches = useBranchOptions();
  const { remove } = useGeofenceMutations();
  const [editing, setEditing] = useState<GeofenceDto | 'new' | null>(null);
  const [assigning, setAssigning] = useState<GeofenceDto | null>(null);
  const [deleting, setDeleting] = useState<GeofenceDto | null>(null);
  const rows = q.data ?? [];
  const branchList = branches.data.map((b) => ({ id: b.id, name: b.name }));

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('geofences.title')} description={t('geofences.subtitle')} actions={<Button onClick={() => setEditing('new')}><Plus /> {t('geofences.new')}</Button>} />
      <p className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground" data-testid="geofence-precedence"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />{t('geofences.precedence')}</p>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <TableSkeleton cols={7} rows={4} /> : rows.length === 0 ? (
        <EmptyState icon={MapPinned} title={t('geofences.empty')} description={t('geofences.emptyHint')} action={<Button onClick={() => setEditing('new')}><Plus /> {t('geofences.new')}</Button>} />
      ) : (
        <div className="rounded-xl border bg-card shadow-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>{(['name', 'branch', 'shape', 'enforcement', 'assignments', 'active'] as const).map((c) => <TableHead key={c}>{t(`geofences.columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
              <TableBody>
                {rows.map((f) => {
                  const editable = f.editable !== false;
                  const lockedWhy = editable ? null : (f.hiddenAssignments ?? 0) > 0 ? t('geofences.readOnlyReach', { count: f.hiddenAssignments ?? 0 }) : t('geofences.readOnlyBranch');
                  return (
                  <TableRow key={f.id} data-testid="geofence-row" data-editable={editable}>
                    <TableCell className="font-medium" dir="auto">
                      {f.name}
                      {lockedWhy ? <span className="mt-0.5 flex items-center gap-1 text-xs font-normal text-muted-foreground" data-testid="geofence-read-only"><Lock className="size-3" aria-hidden />{lockedWhy}</span> : null}
                    </TableCell>
                    <TableCell className="text-sm">{f.branchName ?? t('geofences.fields.orgWide')}</TableCell>
                    <TableCell className="text-xs tnum">{f.polygon ? t('geofences.shape.polygon', { count: f.polygon.length }) : t('geofences.shape.circle', { meters: f.radiusM })}<span className="block text-muted-foreground" dir="ltr">{f.latitude.toFixed(5)}, {f.longitude.toFixed(5)}</span></TableCell>
                    <TableCell><Badge variant={ENFORCEMENT_TONE[f.enforcement]}>{t(`geofences.enforcement.${f.enforcement}`)}</Badge></TableCell>
                    <TableCell className="text-xs">
                      {f.assignments.length === 0 ? <span className="text-destructive">{t('geofences.assignments.noneShort')}</span> : (
                        <span className="flex flex-wrap gap-1">{f.assignments.slice(0, 3).map((a) => <Badge key={a.id} variant="outline" className="text-[10px]">{t(`geofences.scope.${a.scope}`)}{a.targetName ? `: ${a.targetName}` : ''}</Badge>)}{f.assignments.length > 3 ? <Badge variant="secondary" className="text-[10px]">+{f.assignments.length - 3}</Badge> : null}</span>
                      )}
                    </TableCell>
                    <TableCell>{f.isActive ? <Badge variant="success" dot>{t('geofences.active')}</Badge> : <Badge variant="neutral" dot>{t('geofences.inactive')}</Badge>}</TableCell>
                    <TableCell className="text-end">
                      <span className="inline-flex gap-1">
                        <Button size="sm" variant="ghost" disabled={!editable} title={lockedWhy ?? undefined} onClick={() => setAssigning(f)}><Users /> {t('geofences.assignments.button')}</Button>
                        <Button size="icon" variant="ghost" disabled={!editable} title={lockedWhy ?? undefined} aria-label={t('geofences.edit')} onClick={() => setEditing(f)}><Pencil /></Button>
                        <Button size="icon" variant="ghost" disabled={!editable} title={lockedWhy ?? undefined} aria-label={t('geofences.delete')} onClick={() => setDeleting(f)}><Trash2 /></Button>
                      </span>
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <GeofenceTester />
      {editing ? <GeofenceDialog key={editing === 'new' ? 'new' : editing.id} open onOpenChange={(o) => !o && setEditing(null)} fence={editing === 'new' ? null : editing} branches={branchList} /> : null}
      {assigning ? <GeofenceAssignmentsDialog key={assigning.id} fence={assigning} onClose={() => setAssigning(null)} /> : null}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('geofences.deleteTitle', { name: deleting?.name ?? '' })} description={t('geofences.deleteHint')} confirmLabel={t('geofences.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('geofences.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
