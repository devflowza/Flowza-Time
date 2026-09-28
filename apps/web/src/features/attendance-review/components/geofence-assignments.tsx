import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { GEOFENCE_SCOPES, type GeofenceAssignmentInput, type GeofenceDto, type GeofenceScope } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useEmployeeOptions } from '@/features/employees/api';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useTeams } from '@/features/organization/api';
import { AR_NS } from '../i18n';
import { useGeofenceMutations } from '../api';

interface Row extends GeofenceAssignmentInput { key: string; targetName: string | null }
const newKey = () => Math.random().toString(36).slice(2);

/** A searchable employee picker that remembers the label of the chosen employee (the option list follows the search). */
function EmployeeTarget({ value, label, onChange }: { value: string | null; label: string | null; onChange: (id: string | null, label: string | null) => void }) {
  const { t } = useTranslation(AR_NS);
  const employees = useEmployeeOptions();
  const options = value && label && !employees.options.some((o) => o.value === value) ? [{ value, label }, ...employees.options] : employees.options;
  return <Combobox value={value} onChange={(v) => onChange(v, employees.options.find((o) => o.value === v)?.label ?? null)} options={options} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('geofences.assignments.pickEmployee')} />;
}

/**
 * Who a fence applies to. Scopes from the widest to the narrowest (organisation → branch → department → team → employee):
 * the most specific scope that has a fence for the employee wins, and within it the strictest verdict. Saving replaces the
 * whole list.
 */
export function GeofenceAssignmentsDialog({ fence, onClose }: { fence: GeofenceDto | null; onClose: () => void }) {
  const { t } = useTranslation(AR_NS);
  const { t: tc } = useTranslation();
  const { replaceAssignments } = useGeofenceMutations();
  const branches = useBranchOptions();
  const departments = useDepartmentOptions();
  const teams = useTeams({ pageSize: 200, sort: 'name', status: 'active' });
  const teamOptions = useMemo(() => (teams.data?.data ?? []).map((tm) => ({ value: tm.id, label: tm.name })), [teams.data]);
  const [rows, setRows] = useState<Row[]>(() => (fence?.assignments ?? []).map((a) => ({ key: a.id, scope: a.scope, targetId: a.targetId, priority: a.priority, requireOnCheckIn: a.requireOnCheckIn, requireOnCheckOut: a.requireOnCheckOut, targetName: a.targetName })));
  const [touched, setTouched] = useState(false);
  const optionsFor = (scope: GeofenceScope) => (scope === 'branch' ? branches.options : scope === 'department' ? departments.options : scope === 'team' ? teamOptions : []);
  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const invalid = rows.some((r) => (r.scope !== 'org' && !r.targetId) || (!r.requireOnCheckIn && !r.requireOnCheckOut));

  const save = () => {
    setTouched(true);
    if (!fence || invalid) return;
    const assignments: GeofenceAssignmentInput[] = rows.map((r) => ({ scope: r.scope, targetId: r.scope === 'org' ? null : r.targetId, priority: r.priority, requireOnCheckIn: r.requireOnCheckIn, requireOnCheckOut: r.requireOnCheckOut }));
    replaceAssignments.mutate({ id: fence.id, assignments }, { onSuccess: () => { toast.success(t('geofences.assignments.saved')); onClose(); }, onError: toastError });
  };

  return (
    <Dialog open={!!fence} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        <DialogHeader><DialogTitle>{t('geofences.assignments.title', { name: fence?.name ?? '' })}</DialogTitle><DialogDescription>{t('geofences.assignments.hint')}</DialogDescription></DialogHeader>
        <div className="space-y-2">
          {rows.length === 0 ? <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">{t('geofences.assignments.none')}</p> : null}
          {rows.map((r) => (
            <div key={r.key} className="grid items-center gap-2 rounded-md border p-2 sm:grid-cols-[140px_1fr_90px_auto_auto_auto]" data-testid="gf-assignment">
              <Select value={r.scope} onValueChange={(v) => update(r.key, { scope: v as GeofenceScope, targetId: null, targetName: null })}>
                <SelectTrigger aria-label={t('geofences.assignments.scope')}><SelectValue /></SelectTrigger>
                <SelectContent>{GEOFENCE_SCOPES.map((s) => <SelectItem key={s} value={s}>{t(`geofences.scope.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
              {r.scope === 'org' ? <span className="text-sm text-muted-foreground">{t('geofences.assignments.everyone')}</span>
                : r.scope === 'employee' ? <EmployeeTarget value={r.targetId ?? null} label={r.targetName} onChange={(id, label) => update(r.key, { targetId: id, targetName: label })} />
                : <Combobox value={r.targetId ?? null} onChange={(v) => update(r.key, { targetId: v, targetName: optionsFor(r.scope).find((o) => o.value === v)?.label ?? null })} options={optionsFor(r.scope)} placeholder={t('geofences.assignments.pickTarget')} aria-invalid={touched && !r.targetId ? true : undefined} />}
              <Input type="number" min={0} max={1000} className="tnum" aria-label={t('geofences.assignments.priority')} value={r.priority} onChange={(e) => update(r.key, { priority: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })} />
              <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={r.requireOnCheckIn} onCheckedChange={(c) => update(r.key, { requireOnCheckIn: c === true })} />{t('geofences.assignments.onIn')}</label>
              <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={r.requireOnCheckOut} onCheckedChange={(c) => update(r.key, { requireOnCheckOut: c === true })} />{t('geofences.assignments.onOut')}</label>
              <Button type="button" size="icon" variant="ghost" aria-label={t('geofences.assignments.remove')} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 /></Button>
            </div>
          ))}
          {touched && invalid ? <p role="alert" className="text-xs text-destructive">{t('geofences.assignments.invalid')}</p> : null}
          <Button type="button" size="sm" variant="outline" disabled={rows.length >= 200} onClick={() => setRows((rs) => [...rs, { key: newKey(), scope: 'branch', targetId: fence?.branchId ?? null, targetName: null, priority: 100, requireOnCheckIn: true, requireOnCheckOut: true }])}><Plus /> {t('geofences.assignments.add')}</Button>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" loading={replaceAssignments.isPending} onClick={save}>{t('geofences.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
