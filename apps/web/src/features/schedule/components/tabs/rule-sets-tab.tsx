import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, ScrollText, Trash2 } from 'lucide-react';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, fmtMinutes, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { RowActions } from '@/features/organization/components/row-actions';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useRuleSetMutations, useRuleSets } from '../../api';
import type { RuleSetDto } from '../../types';
import { RuleSetDialog } from '../rule-set-dialog';

export function RuleSetsTab() {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const canManage = can('attendance.manage_rules');
  const branches = useBranchOptions();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [includeExpired, setIncludeExpired] = useState(false);
  const query = useMemo(() => ({ branchId: branchId ?? undefined, includeExpired: includeExpired ? 'true' : 'false' }), [branchId, includeExpired]);
  const q = useRuleSets(query);
  const { remove } = useRuleSetMutations();
  const [dialog, setDialog] = useState<{ open: boolean; ruleSet: RuleSetDto | null }>({ open: false, ruleSet: null });
  const [deleting, setDeleting] = useState<RuleSetDto | null>(null);
  const today = todayIso(tz);
  const isActive = (r: RuleSetDto) => r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo > today);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Combobox value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" />
        <label className="flex items-center gap-2 text-sm"><Switch checked={includeExpired} onCheckedChange={setIncludeExpired} aria-label={t('rules.includeExpired')} /> {t('rules.includeExpired')}</label>
        {canManage ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, ruleSet: null })}><Plus /> {t('rules.add')}</Button> : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('rules.hint')}</p>
      <div className="rounded-lg border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading && !q.data ? <TableSkeleton cols={6} rows={4} />
          : q.data && q.data.length === 0 ? <div className="p-4"><EmptyState icon={ScrollText} title={t('rules.empty')} description={t('rules.emptyHint')} action={canManage ? <Button onClick={() => setDialog({ open: true, ruleSet: null })}><Plus /> {t('rules.add')}</Button> : undefined} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{tc('common.name')}</TableHead><TableHead>{tc('common.branch')}</TableHead><TableHead>{t('rules.effective')}</TableHead><TableHead>{t('rules.summary')}</TableHead><TableHead>{t('rules.version')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data?.map((r) => (
                  <TableRow key={r.id} className={!isActive(r) ? 'text-muted-foreground' : undefined}>
                    <TableCell><span className="font-medium">{r.name}</span>{isActive(r) ? <Badge variant="success" className="ms-2">{t('rules.active')}</Badge> : null}</TableCell>
                    <TableCell>{r.branchId ? branches.byId.get(r.branchId)?.name ?? r.branchId.slice(0, 8) : <Badge variant="outline">{t('rules.orgWide')}</Badge>}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs tnum">{fmtDate(r.effectiveFrom)} → {r.effectiveTo ? fmtDate(r.effectiveTo) : '∞'}</TableCell>
                    <TableCell className="text-xs tnum">{t('rules.summaryLine', { graceIn: r.graceInMinutes, fullDay: fmtMinutes(r.minFullDayMinutes), ot: r.overtimeEnabled ? t('rules.otAfter', { min: r.overtimeStartAfterMinutes }) : t('rules.otOff') })}{r.ramadanMode?.enabled ? <Badge variant="secondary" className="ms-2">{t('rules.sections.ramadan')}</Badge> : null}</TableCell>
                    <TableCell className="tnum">v{r.version}</TableCell>
                    <TableCell>{canManage ? <RowActions actions={[{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, ruleSet: r }) }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(r) }]} /> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
      <RuleSetDialog key={`${dialog.open}-${dialog.ruleSet?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} ruleSet={dialog.ruleSet} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('rules.deleteTitle', { name: deleting?.name ?? '' })} description={t('rules.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: (r) => { if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('rules.recalcHint')); else toast.success(t('rules.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
