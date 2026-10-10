import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Building2, CalendarClock, Globe2, Layers, MapPin, Pencil, Plus, ScrollText, Trash2, Users } from 'lucide-react';
import { countryRulePack } from '@flowza/contracts';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate, fmtMinutes, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useModuleEnabled, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { RowActions } from '@/features/organization/components/row-actions';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useEmployeeGroupOptions } from '@/features/policies/api';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree, type LocationTree } from '@/features/locations/use-location-tree';
import { useRuleSetMutations, useRuleSets, useShiftOptions } from '../../api';
import { listFilterOfLocation } from '../../policy-location';
import type { RuleSetDto } from '../../types';
import { RuleSetDialog } from '../rule-set-dialog';
import { WhichPolicyCard } from '../which-policy-card';

/**
 * The scope of a policy as chips: country, location / branch, department, employee group, shift (none = organisation-wide).
 * The where reads as a path of the location tree when the organisation has one ("Muscat HQ › Branch 1 › Site A"); `tree` is
 * the list's indexed tree (built once for every row).
 */
export function PolicyScopeChips({ policy, tree }: { policy: Pick<RuleSetDto, 'countryCode' | 'branchId' | 'departmentId' | 'employeeGroupId' | 'shiftId' | 'locationId'>; tree?: LocationTree }) {
  const { t, i18n } = useTranslation('schedule');
  const enterprise = useModuleEnabled('attendance_policies');
  const branches = useBranchOptions(true);
  const departments = useDepartmentOptions();
  const groups = useEmployeeGroupOptions(enterprise);
  const shifts = useShiftOptions(true);
  const chips: Array<{ key: string; icon: React.ReactNode; label: string; title: string }> = [];
  if (policy.countryCode) { const p = countryRulePack(policy.countryCode); chips.push({ key: 'country', icon: <Globe2 className="size-3" />, label: p ? (i18n.language === 'ar' ? p.nameAr : p.name) : policy.countryCode, title: t('policyEditor.scope.country') }); }
  // a group location or a place (its branch is part of its path) — else the branch, as its node's path below the groups
  if (policy.locationId) chips.push({ key: 'location', icon: <MapPin className="size-3" />, label: tree?.labelOf(policy.locationId) || policy.locationId.slice(0, 8), title: t('policyList.location') });
  else if (policy.branchId) {
    const node = tree?.hasGroupLevels ? tree.branchNodeOf.get(policy.branchId) : undefined;
    chips.push({ key: 'branch', icon: <Building2 className="size-3" />, label: (node ? tree?.labelOf(node.id) : '') || (branches.byId.get(policy.branchId)?.name ?? policy.branchId.slice(0, 8)), title: t('policyList.branch') });
  }
  if (policy.departmentId) chips.push({ key: 'department', icon: <Layers className="size-3" />, label: departments.byId.get(policy.departmentId)?.name ?? policy.departmentId.slice(0, 8), title: t('policyEditor.scope.department') });
  if (policy.employeeGroupId) chips.push({ key: 'group', icon: <Users className="size-3" />, label: groups.byId.get(policy.employeeGroupId)?.name ?? policy.employeeGroupId.slice(0, 8), title: t('policyEditor.scope.group') });
  if (policy.shiftId) chips.push({ key: 'shift', icon: <CalendarClock className="size-3" />, label: shifts.byId.get(policy.shiftId)?.name ?? policy.shiftId.slice(0, 8), title: t('policyEditor.scope.shift') });
  if (chips.length === 0) return <Badge variant="outline">{t('rules.orgWide')}</Badge>;
  return <span className="flex flex-wrap gap-1">{chips.map((c) => <Badge key={c.key} variant="secondary" title={c.title} data-testid={`scope-${c.key}`}>{c.icon}<span className="sr-only">{c.title}: </span>{c.label}</Badge>)}</span>;
}

export function RuleSetsTab() {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const can = useCan();
  const enterprise = useModuleEnabled('attendance_policies');
  const canManage = can('attendance.manage_rules');
  const branches = useBranchOptions();
  // Enterprise organisations with a location tree filter the list by location (a branch node = the classic branch filter); the
  // chips read archived locations too (an expired policy may name one)
  const tree = useLocationTree({ enabled: enterprise, includeArchived: true });
  const byLocation = enterprise && (tree.hasGroupLevels || tree.hasPlaceLevels);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [includeExpired, setIncludeExpired] = useState(false);
  const query = useMemo(() => ({
    ...(byLocation ? listFilterOfLocation(locationId ? tree.byId.get(locationId) : null) : { branchId: branchId ?? undefined }),
    includeExpired: includeExpired ? 'true' : 'false',
  }), [byLocation, locationId, tree.byId, branchId, includeExpired]);
  const q = useRuleSets(query);
  const { remove } = useRuleSetMutations();
  const [dialog, setDialog] = useState<{ open: boolean; ruleSet: RuleSetDto | null }>({ open: false, ruleSet: null });
  const [deleting, setDeleting] = useState<RuleSetDto | null>(null);
  const today = todayIso(tz);
  const isActive = (r: RuleSetDto) => r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo > today);
  // most specific first (the order in which they win), then the latest start
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => (b.specificity ?? 0) - (a.specificity ?? 0) || b.effectiveFrom.localeCompare(a.effectiveFrom)), [q.data]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {byLocation
          ? <><label htmlFor="rs-filter-location" className="sr-only">{t('policyList.location')}</label><LocationPicker id="rs-filter-location" value={locationId} onChange={(v) => setLocationId(v)} placeholder={t('policyList.anyLocation')} className="h-8 w-56" /></>
          : <Combobox value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" />}
        <label className="flex items-center gap-2 text-sm"><Switch checked={includeExpired} onCheckedChange={setIncludeExpired} aria-label={t('rules.includeExpired')} /> {t('rules.includeExpired')}</label>
        {canManage ? <Button size="sm" className="ms-auto" onClick={() => setDialog({ open: true, ruleSet: null })}><Plus /> {enterprise ? t('policyEditor.add') : t('rules.add')}</Button> : null}
      </div>
      <p className="text-xs text-muted-foreground">{enterprise ? t('policyList.hint') : t('rules.hint')}</p>
      <div className="rounded-lg border bg-card shadow-card">
        {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading && !q.data ? <TableSkeleton cols={6} rows={4} />
          : q.data && q.data.length === 0 ? <div className="p-4"><EmptyState icon={ScrollText} title={t('rules.empty')} description={t('rules.emptyHint')} action={canManage ? <Button onClick={() => setDialog({ open: true, ruleSet: null })}><Plus /> {t('rules.add')}</Button> : undefined} /></div>
          : (
            <Table>
              <TableHeader><TableRow><TableHead>{tc('common.name')}</TableHead><TableHead>{t('policyList.scope')}</TableHead>{enterprise ? <TableHead title={t('policyList.specificityHint')}>{t('policyList.specificity')}</TableHead> : null}<TableHead>{t('rules.effective')}</TableHead><TableHead>{t('rules.summary')}</TableHead><TableHead>{t('rules.version')}</TableHead><TableHead className="text-end">{tc('common.actions')}</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className={!isActive(r) ? 'text-muted-foreground' : undefined}>
                    <TableCell><span className="font-medium">{r.name}</span>{isActive(r) ? <Badge variant="success" className="ms-2">{t('rules.active')}</Badge> : null}{r.description ? <p className="max-w-xs truncate text-xs text-muted-foreground" title={r.description}>{r.description}</p> : null}</TableCell>
                    <TableCell><PolicyScopeChips policy={r} tree={tree} /></TableCell>
                    {enterprise ? <TableCell className="tnum text-xs">{r.specificity ?? 0}</TableCell> : null}
                    <TableCell className="whitespace-nowrap text-xs tnum">{fmtDate(r.effectiveFrom)} → {r.effectiveTo ? fmtDate(r.effectiveTo) : '∞'}</TableCell>
                    <TableCell className="text-xs tnum">{t('rules.summaryLine', { graceIn: r.graceInMinutes, fullDay: fmtMinutes(r.minFullDayMinutes), ot: r.overtimeEnabled ? t('rules.otAfter', { min: r.overtimeStartAfterMinutes }) : t('rules.otOff') })}{r.ramadanMode?.enabled ? <Badge variant="secondary" className="ms-2">{t('rules.sections.ramadan')}</Badge> : null}{enterprise && r.policy?.points?.enabled ? <Badge variant="info" className="ms-2">{t('policyList.points')}</Badge> : null}</TableCell>
                    <TableCell className="tnum">v{r.version}</TableCell>
                    <TableCell>{canManage ? <RowActions actions={[{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setDialog({ open: true, ruleSet: r }) }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeleting(r) }]} /> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </div>
      {enterprise ? <WhichPolicyCard /> : null}
      <RuleSetDialog key={`${dialog.open}-${dialog.ruleSet?.id ?? 'new'}`} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} ruleSet={dialog.ruleSet} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('rules.deleteTitle', { name: deleting?.name ?? '' })} description={t('rules.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: (r) => { if (r.recalculationJobId) toastJobQueued(r.recalculationJobId, navigate, t('rules.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(t('rules.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </div>
  );
}
