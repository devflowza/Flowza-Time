import { useMemo, useState } from 'react';
import { Controller, get, useFieldArray, useForm, useWatch, type Control, type FieldErrors, type FieldPath, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { AlertTriangle, Info, Plus, Trash2 } from 'lucide-react';
import { COUNTRY_PACK_CODES, COUNTRY_RULE_PACKS, DEFAULT_POLICY_SECTIONS, DISCIPLINE_ACTIONS, MISSING_PUNCH_BEHAVIORS, PUNCH_INTERPRETATIONS, ROUNDING_MODES, attendanceRuleSetInputSchema, countryRulePack, DEFAULT_ATTENDANCE_RULES, policyDefaultsFromPack, type AttendanceRuleSetInput, type ComplianceWarningDto, type CountryPackCode } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useDebounced } from '@/hooks/use-debounced';
import { useActiveMembership, useModuleEnabled, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { blankToUndefined, toNumber } from '@/features/organization/form-utils';
import { toastJobQueued } from '@/features/employees/job-toast';
import { useEmployeeGroupOptions, usePolicyCompliance } from '@/features/policies/api';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree, type LocationTree } from '@/features/locations/use-location-tree';
import { useRuleSetMutations, useShiftOptions } from '../api';
import { locationOfScope, scopeOfLocation } from '../policy-location';
import type { RuleSetDto } from '../types';

type FormValues = z.input<typeof attendanceRuleSetInputSchema>;
type Path = FieldPath<FormValues>;
const OT_ROUNDING = [0, 5, 10, 15, 30, 60] as const;
const PUNCH_ROUNDING = [0, 5, 10, 15, 30] as const;
const GEOFENCE_MODES = ['inherit', 'off', 'flag', 'block'] as const;
/** Scope dimensions beyond the branch (Enterprise attendance_policies): a request without the module never carries them. */
const ENTERPRISE_SCOPE_KEYS = ['countryCode', 'departmentId', 'employeeGroupId', 'shiftId', 'locationId'] as const;

/**
 * The sections of the attendance policy editor, in order. `discipline` and `regularisation` exist only with the Enterprise
 * module attendance_policies; without it they — and the Enterprise fields of the other sections — are hidden, not disabled.
 */
const SECTIONS = ['general', 'late', 'attendance', 'overtime', 'discipline', 'regularisation', 'ramadan'] as const;
type SectionKey = (typeof SECTIONS)[number];
const ENTERPRISE_SECTIONS: ReadonlySet<SectionKey> = new Set(['discipline', 'regularisation']);
const FIELD_SECTIONS: Record<string, SectionKey> = {
  name: 'general', description: 'general', branchId: 'general', locationId: 'general', countryCode: 'general', departmentId: 'general', employeeGroupId: 'general', shiftId: 'general', effectiveFrom: 'general', effectiveTo: 'general',
  graceInMinutes: 'late', graceOutMinutes: 'late', lateThresholdMinutes: 'late', earlyDepartureThresholdMinutes: 'late', punchRoundingMinutes: 'late', punchRoundingMode: 'late', workedRoundingMinutes: 'late', workedRoundingMode: 'late',
  minFullDayMinutes: 'attendance', halfDayThresholdMinutes: 'attendance', punchInterpretation: 'attendance', duplicatePunchWindowSeconds: 'attendance', missingPunchBehavior: 'attendance', autoAbsentWithoutPunches: 'attendance',
  overtimeEnabled: 'overtime', overtimeStartAfterMinutes: 'overtime', overtimeMinBlockMinutes: 'overtime', overtimeRoundingMinutes: 'overtime', overtimeMaxMinutesPerDay: 'overtime', countEarlyInAsOvertime: 'overtime', overtimeRequiresScheduledHours: 'overtime', weeklyOffWorkCountsAsOvertime: 'overtime', holidayWorkCountsAsOvertime: 'overtime',
  ramadanMode: 'ramadan', 'policy.countryPack': 'general', 'policy.late': 'late', 'policy.methods': 'attendance', 'policy.overtime': 'overtime', 'policy.points': 'discipline', 'policy.regularisation': 'regularisation',
};
/** The section a field path belongs to (`policy.overtime.rates.regular` → overtime). */
function sectionOfField(path: string): SectionKey {
  const [first, second] = path.split('.');
  return FIELD_SECTIONS[first === 'policy' ? `policy.${second ?? ''}` : first ?? ''] ?? 'general';
}
/** Every error path of an RHF errors object (leaves only). */
function errorPaths(errors: FieldErrors<FormValues>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(errors as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if ('message' in v || 'type' in v) out.push(path);
    else out.push(...errorPaths(v as FieldErrors<FormValues>, path));
  }
  return out;
}

function toDefaults(r: RuleSetDto | null, today: string, pack: CountryPackCode | null): FormValues {
  if (!r) {
    const blank: FormValues = { ...DEFAULT_ATTENDANCE_RULES, name: '', description: '', branchId: null, locationId: null, countryCode: null, departmentId: null, employeeGroupId: null, shiftId: null, effectiveFrom: today, effectiveTo: null, overtimeMaxMinutesPerDay: null, policy: structuredClone(DEFAULT_POLICY_SECTIONS) };
    const p = pack ? COUNTRY_RULE_PACKS[pack] : null;
    if (!p) return blank;
    const d = policyDefaultsFromPack(p);
    return { ...blank, ...d, name: p.name, policy: { ...blank.policy, countryPack: d.policy.countryPack, overtime: { ...DEFAULT_POLICY_SECTIONS.overtime, ...d.policy.overtime } } };
  }
  const { id: _id, version: _v, createdAt: _c, updatedAt: _u, specificity: _s, ...rules } = r;
  return { ...DEFAULT_ATTENDANCE_RULES, ...rules, description: rules.description ?? '', policy: rules.policy ?? structuredClone(DEFAULT_POLICY_SECTIONS), ramadanMode: { ...DEFAULT_ATTENDANCE_RULES.ramadanMode, ...(rules.ramadanMode ?? {}) } };
}

const nullableNumber = (v: unknown): unknown => (v === '' || v === null || v === undefined ? null : Number(v));

function Num({ name, label, hint, id, register, errors, min, max, step, nullable, placeholder, warning }: { name: Path; label: string; hint?: string; id: string; register: UseFormRegister<FormValues>; errors: FieldErrors<FormValues>; min?: number; max?: number; step?: number; nullable?: boolean; placeholder?: string; warning?: React.ReactNode }) {
  const error = (get(errors, name) as { message?: string } | undefined)?.message;
  return (
    <div className="space-y-1">
      <FormField label={label} htmlFor={id} hint={hint} error={error}><Input id={id} type="number" min={min ?? 0} max={max} step={step} dir="ltr" className="tnum" placeholder={placeholder} {...register(name, { setValueAs: nullable ? nullableNumber : toNumber })} aria-invalid={!!error} /></FormField>
      {warning}
    </div>
  );
}
function Bool({ name, label, hint, id, control }: { name: Path; label: string; hint?: string; id: string; control: Control<FormValues> }) {
  return (
    <Controller control={control} name={name} render={({ field }) => (
      <div className="flex items-center justify-between gap-4 rounded-md border p-3">
        <div className="min-w-0"><label htmlFor={id} className="text-sm font-medium">{label}</label>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>
        <Switch id={id} checked={!!field.value} onCheckedChange={field.onChange} />
      </div>
    )} />
  );
}
function Section({ title, hint, children, enterprise }: { title: string; hint?: string; children: React.ReactNode; enterprise?: boolean }) {
  const { t } = useTranslation('schedule');
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div><h4 className="flex items-center gap-2 text-sm font-semibold">{title}{enterprise ? <Badge variant="info" className="text-[10px]">{t('policyEditor.enterprise')}</Badge> : null}</h4>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>
      {children}
    </section>
  );
}

/** The compliance warnings of one field, shown under it. */
function FieldWarnings({ warnings }: { warnings: ComplianceWarningDto[] | undefined }) {
  const { t } = useTranslation('schedule');
  if (!warnings?.length) return null;
  return <>{warnings.map((w) => <p key={w.code} className={cn('flex items-start gap-1 text-xs', w.severity === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>{w.severity === 'warning' ? <AlertTriangle className="mt-0.5 size-3 shrink-0" /> : <Info className="mt-0.5 size-3 shrink-0" />}{t(`policyEditor.compliance.codes.${w.code}`, w.params as Record<string, unknown>)}</p>)}</>;
}

/** Repeated late: off, or N late arrivals within D days (one REPEATED_LATE occurrence for the points). */
function RepeatedLateField({ control }: { control: Control<FormValues> }) {
  const { t } = useTranslation('schedule');
  return (
    <Controller control={control} name="policy.late.repeatedLate" render={({ field, fieldState }) => {
      const v = field.value as { occurrences: number; periodDays: number } | null | undefined;
      const set = (patch: Partial<{ occurrences: number; periodDays: number }>) => field.onChange({ occurrences: v?.occurrences ?? 3, periodDays: v?.periodDays ?? 30, ...patch });
      return (
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0"><label htmlFor="rs-repeated" className="text-sm font-medium">{t('policyEditor.fields.repeatedLate')}</label><p className="text-xs text-muted-foreground">{t('policyEditor.hints.repeatedLate')}</p></div>
            <Switch id="rs-repeated" checked={!!v} onCheckedChange={(on) => field.onChange(on ? { occurrences: 3, periodDays: 30 } : null)} />
          </div>
          {v ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('policyEditor.fields.repeatedLateOccurrences')} htmlFor="rs-repeated-n"><Input id="rs-repeated-n" type="number" min={2} max={31} dir="ltr" className="tnum" value={v.occurrences} onChange={(e) => set({ occurrences: Number(e.target.value) })} /></FormField>
              <FormField label={t('policyEditor.fields.repeatedLateDays')} htmlFor="rs-repeated-d"><Input id="rs-repeated-d" type="number" min={7} max={90} dir="ltr" className="tnum" value={v.periodDays} onChange={(e) => set({ periodDays: Number(e.target.value) })} /></FormField>
            </div>
          ) : null}
          {fieldState.error ? <p className="text-xs text-destructive" role="alert">{t('policyEditor.invalidRepeatedLate')}</p> : null}
        </div>
      );
    }} />
  );
}

/** The disciplinary escalation ladder: ascending thresholds, each action once. */
function EscalationEditor({ control, register, errors }: { control: Control<FormValues>; register: UseFormRegister<FormValues>; errors: FieldErrors<FormValues> }) {
  const { t } = useTranslation('schedule');
  const { fields, append, remove } = useFieldArray({ control, name: 'policy.points.escalation' });
  const steps = useWatch({ control, name: 'policy.points.escalation' }) ?? [];
  const used = new Set(steps.map((s) => s?.action));
  const nextAction = DISCIPLINE_ACTIONS.find((a) => !used.has(a));
  const lastPoints = steps.reduce((m, s) => Math.max(m, Number(s?.points ?? 0)), 0);
  const ladderError = get(errors, 'policy.points.escalation') as { message?: string; root?: { message?: string } } | undefined;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{t('policyEditor.fields.escalation')}</span>
        <Button type="button" size="sm" variant="outline" disabled={!nextAction} onClick={() => nextAction && append({ points: lastPoints + 3, action: nextAction })}><Plus /> {t('policyEditor.addStep')}</Button>
      </div>
      {fields.length === 0 ? <p className="text-xs text-muted-foreground">{t('policyEditor.noEscalation')}</p> : (
        <ol className="space-y-2">
          {fields.map((f, i) => (
            <li key={f.id} className="flex flex-wrap items-end gap-2" data-testid="escalation-step">
              <FormField label={t('policyEditor.fields.stepPoints')} htmlFor={`rs-esc-${i}`} className="w-32"><Input id={`rs-esc-${i}`} type="number" min={0.5} max={1000} step={0.5} dir="ltr" className="tnum" {...register(`policy.points.escalation.${i}.points` as const, { setValueAs: toNumber })} /></FormField>
              <FormField label={t('policyEditor.fields.stepAction')} htmlFor={`rs-esc-action-${i}`} className="min-w-48 flex-1">
                <Controller control={control} name={`policy.points.escalation.${i}.action` as const} render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id={`rs-esc-action-${i}`}><SelectValue /></SelectTrigger><SelectContent>{DISCIPLINE_ACTIONS.map((a) => <SelectItem key={a} value={a}>{t(`policyEditor.actions.${a}`)}</SelectItem>)}</SelectContent></Select>
                )} />
              </FormField>
              <Button type="button" variant="ghost" size="icon" aria-label={t('policyEditor.removeStep')} onClick={() => remove(i)}><Trash2 /></Button>
            </li>
          ))}
        </ol>
      )}
      {ladderError ? <p className="text-xs text-destructive" role="alert">{t('policyEditor.invalidEscalation')}</p> : null}
    </div>
  );
}

/** The nodes a member scoped to some branches may name: their branches and the places in them. */
const BRANCH_SCOPED_ROLES = ['branch', 'place'] as const;

/**
 * The policy's "where" as one Location field (Enterprise, organisations with group or place levels — docs/locations.md §3): any
 * node of the tree. A branch node is stored as `branchId`, a group node (Headquarters, Region…) as `locationId` alone, a place
 * (Site, Floor, Zone…) as `locationId` + its branch. A stored policy shows its location, else its branch's node. A member scoped
 * to some branches only names one of their branches or a place in it (a group location spans branches beyond their scope).
 */
function PolicyLocationField({ control, setScope, tree, editing, error }: { control: Control<FormValues>; setScope: (where: { branchId: string | null; locationId: string | null }) => void; tree: LocationTree; editing: boolean; error?: string }) {
  const { t } = useTranslation('schedule');
  const allBranches = useActiveMembership()?.allBranches ?? true;
  const branchId = useWatch({ control, name: 'branchId' }) ?? null;
  const locationId = useWatch({ control, name: 'locationId' }) ?? null;
  return (
    <FormField label={t('policyEditor.scope.location')} htmlFor="rs-location" optional hint={editing ? t('policyEditor.scope.immutable') : t('policyEditor.scope.locationHint')} error={error}>
      <LocationPicker id="rs-location" value={locationOfScope(tree, { branchId, locationId })} onChange={(_, node) => setScope(scopeOfLocation(node))} roles={allBranches || editing ? undefined : BRANCH_SCOPED_ROLES}
        clearable={!editing} disabled={editing} includeArchived={editing} placeholder={t('policyEditor.scope.anyLocation')} aria-invalid={!!error} />
    </FormField>
  );
}

/**
 * The attendance POLICY editor (attendanceRuleSetInputSchema): an effective-dated rule set with its scope and sections —
 * General, Late & early, Attendance, Overtime, Discipline, Regularisation, Ramadan. The Enterprise parts (scope beyond the
 * branch, country packs and compliance, very / repeated late, check-in methods, weekly overtime and rates, points, limits)
 * appear only with the module attendance_policies; without it the request never carries non-default sections or extra scope.
 * With the module, an organisation that has group or place levels names the policy's branch through a Location field instead
 * (a region, a branch, a site, a floor…). `pack` opens a new policy prefilled from a country rule pack.
 */
export function RuleSetDialog({ open, onOpenChange, ruleSet, pack = null }: { open: boolean; onOpenChange: (o: boolean) => void; ruleSet: RuleSetDto | null; pack?: CountryPackCode | null }) {
  const { t, i18n } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const navigate = useNavigate();
  const enterprise = useModuleEnabled('attendance_policies');
  const branches = useBranchOptions();
  const { create, update } = useRuleSetMutations();
  const [tab, setTab] = useState<SectionKey>('general');
  const form = useForm<FormValues, unknown, AttendanceRuleSetInput>({ resolver: zodResolver(attendanceRuleSetInputSchema), defaultValues: toDefaults(ruleSet, todayIso(tz), pack) });
  const { register, control, setValue, formState: { errors, isSubmitting } } = form;
  const otEnabled = useWatch({ control, name: 'overtimeEnabled' }) ?? true;
  const ramadan = useWatch({ control, name: 'ramadanMode.enabled' }) ?? false;
  const pointsOn = useWatch({ control, name: 'policy.points.enabled' }) ?? false;
  const branchId = useWatch({ control, name: 'branchId' }) ?? null;
  const countryCode = useWatch({ control, name: 'countryCode' }) ?? null;
  const countryPack = useWatch({ control, name: 'policy.countryPack' }) ?? null;
  const departments = useDepartmentOptions(branchId);
  const groups = useEmployeeGroupOptions(enterprise);
  const shifts = useShiftOptions();
  const editing = !!ruleSet;
  // the location tree (Enterprise only); a stored policy may name an archived location or branch, which must stay readable
  const tree = useLocationTree({ enabled: enterprise, includeArchived: editing });
  const byLocation = enterprise && (tree.hasGroupLevels || tree.hasPlaceLevels || !!ruleSet?.locationId);
  const setScope = (where: { branchId: string | null; locationId: string | null }) => {
    const opts = { shouldDirty: true, shouldValidate: form.formState.isSubmitted } as const;
    setValue('branchId', where.branchId, opts);
    setValue('locationId', where.locationId, opts);
  };
  const packName = (code: string) => { const p = countryRulePack(code); return p ? (i18n.language === 'ar' ? p.nameAr : p.name) : code; };
  const countryOptions = useMemo<ComboboxOption[]>(() => {
    const codes: string[] = [...COUNTRY_PACK_CODES];
    if (countryCode && !codes.includes(countryCode)) codes.push(countryCode);
    return codes.map((c) => ({ value: c, label: packName(c), description: c }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode, i18n.language]);

  // Compliance: the draft (debounced) against the country's pack, when the policy names a country (Enterprise)
  const all = useWatch({ control });
  const draft = useDebounced(all, 600);
  // the country comes from the same (debounced) draft, so a draft is never checked against another country's pack
  const draftCountry = enterprise ? ((draft as FormValues).countryCode ?? null) : null;
  const parsedDraft = useMemo(() => {
    if (!draftCountry) return null;
    const r = attendanceRuleSetInputSchema.safeParse({ ...draft, name: (draft as FormValues).name || 'draft' });
    return r.success ? r.data : null;
  }, [draft, draftCountry]);
  const compliance = usePolicyCompliance(draftCountry, parsedDraft);
  const warnings = useMemo(() => (enterprise && countryCode && compliance.data?.countryCode === countryCode ? compliance.data.warnings : []), [compliance.data, enterprise, countryCode]);
  const warningsOf = (field: string) => warnings.filter((w) => w.field === field);
  const warningSections = new Set(warnings.filter((w) => w.severity === 'warning').map((w) => sectionOfField(w.field)));
  const errorSections = new Set(errorPaths(errors).map(sectionOfField));

  const applyPack = (code: string) => {
    const p = countryRulePack(code);
    if (!p) return;
    const d = policyDefaultsFromPack(p);
    const opts = { shouldDirty: true, shouldValidate: true } as const;
    setValue('countryCode', d.countryCode, opts);
    setValue('minFullDayMinutes', d.minFullDayMinutes, opts);
    setValue('halfDayThresholdMinutes', d.halfDayThresholdMinutes, opts);
    setValue('overtimeMaxMinutesPerDay', d.overtimeMaxMinutesPerDay, opts);
    setValue('ramadanMode', { ...form.getValues('ramadanMode'), ...d.ramadanMode }, opts);
    setValue('policy.countryPack', d.policy.countryPack, opts);
    setValue('policy.overtime.weeklyThresholdMinutes', d.policy.overtime.weeklyThresholdMinutes, opts);
    setValue('policy.overtime.maxDailyWorkMinutes', d.policy.overtime.maxDailyWorkMinutes, opts);
    setValue('policy.overtime.rates', { ...d.policy.overtime.rates }, opts);
    toast.success(t('policyEditor.packApplied', { country: packName(code), version: p.version }));
  };

  /** Without the module the request carries neither the policy sections nor a scope beyond the branch. */
  const toRequest = (values: AttendanceRuleSetInput): Partial<AttendanceRuleSetInput> => {
    if (enterprise) return values;
    const out: Partial<AttendanceRuleSetInput> = { ...values };
    delete out.policy;
    for (const k of ENTERPRISE_SCOPE_KEYS) delete out[k];
    return out;
  };
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const body = toRequest(values);
      const res = ruleSet ? await update.mutateAsync({ id: ruleSet.id, input: body }) : await create.mutateAsync(body);
      if (res.recalculationJobId) toastJobQueued(res.recalculationJobId, navigate, t('rules.recalcHint'), { to: '/attendance?tab=recalc' }); else toast.success(ruleSet ? t('rules.updated') : t('rules.created'));
      onOpenChange(false);
    } catch (e) { toastError(e); }
  }, (errs) => {
    // open the first section with an error (hidden sections are still validated)
    const first = SECTIONS.find((s) => errorPaths(errs).some((p) => sectionOfField(p) === s));
    if (first) setTab(first);
  });

  const n = (name: Path, label: string, opts: { min?: number; max?: number; step?: number; hint?: string; nullable?: boolean; placeholder?: string; warn?: string } = {}) =>
    <Num key={name} name={name} id={`rs-${name.replace(/\./g, '-')}`} label={label} hint={opts.hint} register={register} errors={errors} min={opts.min} max={opts.max} step={opts.step} nullable={opts.nullable} placeholder={opts.placeholder} warning={opts.warn ? <FieldWarnings warnings={warningsOf(opts.warn)} /> : undefined} />;
  const rn = (name: Path, key: string, opts: { min?: number; max?: number; hint?: boolean; warn?: boolean } = {}) => n(name, t(`rules.fields.${key}`), { min: opts.min, max: opts.max, hint: opts.hint ? t(`rules.hints.${key}`) : undefined, warn: opts.warn ? name : undefined });
  const b = (name: Path, label: string, hint?: string) => <Bool key={name} name={name} id={`rs-${name.replace(/\./g, '-')}`} label={label} hint={hint} control={control} />;
  const rb = (name: Path, key: string) => b(name, t(`rules.fields.${key}`), t(`rules.hints.${key}`));
  const roundingSelect = (name: 'overtimeRoundingMinutes' | 'punchRoundingMinutes' | 'workedRoundingMinutes', values: readonly number[], label: string) => (
    <FormField label={label} htmlFor={`rs-${name}`} error={errors[name]?.message}>
      <Controller control={control} name={name} render={({ field }) => (
        <Select value={String(field.value ?? 0)} onValueChange={(v) => field.onChange(Number(v))}>
          <SelectTrigger id={`rs-${name}`}><SelectValue /></SelectTrigger>
          <SelectContent>{values.map((v) => <SelectItem key={v} value={String(v)}>{v === 0 ? t('rules.noRounding') : t('rules.minutesValue', { count: v })}</SelectItem>)}</SelectContent>
        </Select>
      )} />
    </FormField>
  );
  const modeSelect = (name: 'punchRoundingMode' | 'workedRoundingMode', label: string) => (
    <FormField label={label} htmlFor={`rs-${name}`} error={errors[name]?.message}>
      <Controller control={control} name={name} render={({ field }) => (
        <Select value={field.value ?? 'NONE'} onValueChange={field.onChange}>
          <SelectTrigger id={`rs-${name}`}><SelectValue /></SelectTrigger>
          <SelectContent>{ROUNDING_MODES.map((m) => <SelectItem key={m} value={m}>{t(`rules.roundingModes.${m}`)}</SelectItem>)}</SelectContent>
        </Select>
      )} />
    </FormField>
  );
  const scopeCombo = (name: 'departmentId' | 'employeeGroupId' | 'shiftId' | 'countryCode', label: string, options: ComboboxOption[], loading: boolean, placeholder: string) => (
    <FormField label={label} htmlFor={`rs-${name}`} optional error={(errors[name] as { message?: string } | undefined)?.message}>
      <Controller control={control} name={name} render={({ field }) => <Combobox id={`rs-${name}`} value={(field.value as string | null | undefined) ?? null} onChange={(v) => field.onChange(v)} options={options} loading={loading} clearable={!editing} disabled={editing} placeholder={placeholder} />} />
    </FormField>
  );
  const sections = SECTIONS.filter((s) => enterprise || !ENTERPRISE_SECTIONS.has(s));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader><DialogTitle>{ruleSet ? t('policyEditor.edit') : t('policyEditor.add')}</DialogTitle><DialogDescription>{t('rules.dialogHint')}</DialogDescription></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {enterprise && countryCode ? (
            <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30" data-testid="compliance-panel" aria-live="polite">
              <p className="font-medium">{t('policyEditor.compliance.title', { country: packName(countryCode) })}</p>
              {!countryRulePack(countryCode) ? <p className="text-xs text-muted-foreground">{t('policyEditor.compliance.noPack')}</p>
                : compliance.isFetching && !compliance.data ? <p className="text-xs text-muted-foreground">{t('policyEditor.compliance.checking')}</p>
                : warnings.length === 0 ? <p className="text-xs text-muted-foreground">{t('policyEditor.compliance.none')}</p>
                : (
                  <ul className="mt-1 space-y-1">
                    {warnings.map((w) => (
                      <li key={`${w.code}-${w.field}`}>
                        <button type="button" className="flex items-start gap-1.5 text-start text-xs hover:underline" onClick={() => setTab(sectionOfField(w.field))}>
                          <Badge variant={w.severity === 'warning' ? 'warning' : 'neutral'} className="text-[10px]">{t(`policyEditor.compliance.severity.${w.severity}`)}</Badge>
                          <span>{t(`policyEditor.compliance.codes.${w.code}`, w.params as Record<string, unknown>)} <span className="text-muted-foreground">· {t(`policyEditor.tabs.${sectionOfField(w.field)}`)}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              <p className="mt-1 text-[11px] text-muted-foreground">{t('policyEditor.compliance.disclaimer')}</p>
            </div>
          ) : null}

          <Tabs value={tab} onValueChange={(v) => setTab(v as SectionKey)}>
            <TabsList aria-label={t('policyEditor.sectionsLabel')} className="h-auto max-w-full flex-wrap justify-start">
              {sections.map((s) => (
                <TabsTrigger key={s} value={s} className="gap-1.5">
                  {t(`policyEditor.tabs.${s}`)}
                  {errorSections.has(s) ? <><span className="size-1.5 rounded-full bg-destructive" aria-hidden /><span className="sr-only">{t('policyEditor.hasErrors')}</span></> : warningSections.has(s) ? <><span className="size-1.5 rounded-full bg-amber-500" aria-hidden /><span className="sr-only">{t('policyEditor.hasWarnings')}</span></> : null}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* every section stays mounted (hidden by CSS when inactive) so its fields keep their values and validate */}
            <TabsContent value="general" forceMount className="space-y-4 data-[state=inactive]:hidden">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <FormField label={tc('common.name')} htmlFor="rs-name" required error={errors.name?.message} className="lg:col-span-2"><Input id="rs-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
                <FormField label={t('rules.effectiveFrom')} htmlFor="rs-from" required error={errors.effectiveFrom?.message}><Input id="rs-from" type="date" dir="ltr" {...register('effectiveFrom')} aria-invalid={!!errors.effectiveFrom} /></FormField>
                <FormField label={t('rules.effectiveTo')} htmlFor="rs-to" optional error={errors.effectiveTo?.message} hint={t('rules.effectiveToHint')}><Input id="rs-to" type="date" dir="ltr" {...register('effectiveTo', { setValueAs: (v: unknown) => (v === '' ? null : v) })} /></FormField>
              </div>
              <FormField label={t('policyEditor.fields.description')} htmlFor="rs-description" optional error={errors.description?.message}><Input id="rs-description" maxLength={500} {...register('description')} /></FormField>
              <Section title={t('policyEditor.scope.title')} hint={enterprise ? t('policyEditor.scope.hint') : undefined}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {enterprise ? scopeCombo('countryCode', t('policyEditor.scope.country'), countryOptions, false, t('policyEditor.scope.anyCountry')) : null}
                  {byLocation ? <PolicyLocationField control={control} setScope={setScope} tree={tree} editing={editing} error={errors.locationId?.message ?? errors.branchId?.message} /> : (
                    <FormField label={tc('common.branch')} htmlFor="rs-branch" optional hint={editing ? t('policyEditor.scope.immutable') : t('rules.branchHint')} error={errors.branchId?.message}>
                      <Controller control={control} name="branchId" render={({ field }) => <Combobox id="rs-branch" value={field.value ?? null} onChange={(v) => field.onChange(v)} options={branches.options} loading={branches.isLoading} clearable={!editing} disabled={editing} placeholder={t('rules.orgWide')} />} />
                    </FormField>
                  )}
                  {enterprise ? <>
                    {scopeCombo('departmentId', t('policyEditor.scope.department'), departments.options, departments.isLoading, t('policyEditor.scope.anyDepartment'))}
                    {scopeCombo('employeeGroupId', t('policyEditor.scope.group'), groups.options, groups.isLoading, t('policyEditor.scope.anyGroup'))}
                    {scopeCombo('shiftId', t('policyEditor.scope.shift'), shifts.options, shifts.isLoading, t('policyEditor.scope.anyShift'))}
                  </> : null}
                </div>
                {enterprise ? <FieldWarnings warnings={warningsOf('shiftId')} /> : null}
              </Section>
              {enterprise && !editing ? (
                <Section title={t('policyEditor.pack.title')} hint={t('policyEditor.pack.hint')}>
                  <FormField label={t('policyEditor.pack.pick')} htmlFor="rs-pack">
                    <Select value={countryPack?.code ?? ''} onValueChange={applyPack}>
                      <SelectTrigger id="rs-pack"><SelectValue placeholder={t('policyEditor.pack.placeholder')} /></SelectTrigger>
                      <SelectContent>{COUNTRY_PACK_CODES.map((c) => <SelectItem key={c} value={c}>{packName(c)} · {COUNTRY_RULE_PACKS[c].version}</SelectItem>)}</SelectContent>
                    </Select>
                  </FormField>
                  {countryPack ? <p className="text-xs text-muted-foreground">{t('policyEditor.pack.applied', { country: packName(countryPack.code), version: countryPack.version, law: countryRulePack(countryPack.code)?.law ?? '', verifiedOn: countryRulePack(countryPack.code)?.verifiedOn ?? '' })}</p> : null}
                </Section>
              ) : enterprise && countryPack ? <p className="text-xs text-muted-foreground">{t('policyEditor.pack.from', { country: packName(countryPack.code), version: countryPack.version })}</p> : null}
            </TabsContent>

            <TabsContent value="late" forceMount className="space-y-4 data-[state=inactive]:hidden">
              <Section title={t('policyEditor.sections.grace')} hint={t('rules.sections.graceHint')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  {rn('graceInMinutes', 'graceInMinutes', { max: 240 })}{rn('graceOutMinutes', 'graceOutMinutes', { max: 240 })}
                  {rn('lateThresholdMinutes', 'lateThresholdMinutes', { max: 480, hint: true })}{rn('earlyDepartureThresholdMinutes', 'earlyDepartureThresholdMinutes', { max: 480 })}
                </div>
              </Section>
              {enterprise ? (
                <Section title={t('policyEditor.sections.lateEscalation')} hint={t('policyEditor.sections.lateEscalationHint')} enterprise>
                  {n('policy.late.veryLateAfterMinutes', t('policyEditor.fields.veryLateAfterMinutes'), { min: 1, max: 720, nullable: true, hint: t('policyEditor.hints.veryLateAfterMinutes'), placeholder: t('policyEditor.off') })}
                  <RepeatedLateField control={control} />
                </Section>
              ) : null}
              <Section title={t('rules.sections.rounding')} hint={t('rules.sections.roundingHint')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  {roundingSelect('punchRoundingMinutes', PUNCH_ROUNDING, t('rules.fields.punchRoundingMinutes'))}{modeSelect('punchRoundingMode', t('rules.fields.punchRoundingMode'))}
                  {roundingSelect('workedRoundingMinutes', PUNCH_ROUNDING, t('rules.fields.workedRoundingMinutes'))}{modeSelect('workedRoundingMode', t('rules.fields.workedRoundingMode'))}
                </div>
              </Section>
            </TabsContent>

            <TabsContent value="attendance" forceMount className="space-y-4 data-[state=inactive]:hidden">
              <Section title={t('policyEditor.sections.day')} hint={t('policyEditor.sections.dayHint')}>
                <div className="grid gap-3 sm:grid-cols-2">{rn('minFullDayMinutes', 'minFullDayMinutes', { max: 1440, hint: true, warn: true })}{rn('halfDayThresholdMinutes', 'halfDayThresholdMinutes', { max: 1440, hint: true })}</div>
              </Section>
              <Section title={t('rules.sections.punches')} hint={t('rules.sections.punchesHint')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label={t('rules.fields.punchInterpretation')} htmlFor="rs-interp" hint={t('rules.hints.punchInterpretation')} error={errors.punchInterpretation?.message}>
                    <Controller control={control} name="punchInterpretation" render={({ field }) => (
                      <Select value={field.value ?? 'FIRST_LAST'} onValueChange={field.onChange}><SelectTrigger id="rs-interp"><SelectValue /></SelectTrigger><SelectContent>{PUNCH_INTERPRETATIONS.map((m) => <SelectItem key={m} value={m}>{t(`rules.interpretations.${m}`)}</SelectItem>)}</SelectContent></Select>
                    )} />
                  </FormField>
                  {rn('duplicatePunchWindowSeconds', 'duplicatePunchWindowSeconds', { max: 3600, hint: true })}
                </div>
              </Section>
              {enterprise ? (
                <Section title={t('policyEditor.sections.methods')} hint={t('policyEditor.sections.methodsHint')} enterprise>
                  <div className="grid gap-2 sm:grid-cols-3">{b('policy.methods.web', t('policyEditor.fields.methodWeb'))}{b('policy.methods.mobile', t('policyEditor.fields.methodMobile'))}{b('policy.methods.selfie', t('policyEditor.fields.methodSelfie'))}</div>
                  <FormField label={t('policyEditor.fields.requireGeofence')} htmlFor="rs-geofence" hint={t('policyEditor.hints.requireGeofence')}>
                    <Controller control={control} name="policy.methods.requireGeofence" render={({ field }) => (
                      <Select value={field.value ?? 'inherit'} onValueChange={field.onChange}><SelectTrigger id="rs-geofence"><SelectValue /></SelectTrigger><SelectContent>{GEOFENCE_MODES.map((m) => <SelectItem key={m} value={m}>{t(`policyEditor.geofence.${m}`)}</SelectItem>)}</SelectContent></Select>
                    )} />
                  </FormField>
                </Section>
              ) : null}
              <Section title={t('rules.sections.missing')} hint={t('rules.sections.missingHint')}>
                <FormField label={t('rules.fields.missingPunchBehavior')} htmlFor="rs-missing" hint={t('policyEditor.hints.missingPunchBehavior')} error={errors.missingPunchBehavior?.message}>
                  <Controller control={control} name="missingPunchBehavior" render={({ field }) => (
                    <Select value={field.value ?? 'FLAG_ONLY'} onValueChange={field.onChange}><SelectTrigger id="rs-missing"><SelectValue /></SelectTrigger><SelectContent>{MISSING_PUNCH_BEHAVIORS.map((m) => <SelectItem key={m} value={m}>{m === 'ASSUME_SHIFT_END' ? t('policyEditor.autoCheckout') : t(`rules.missingBehaviors.${m}`)}</SelectItem>)}</SelectContent></Select>
                  )} />
                </FormField>
                {rb('autoAbsentWithoutPunches', 'autoAbsentWithoutPunches')}
              </Section>
            </TabsContent>

            <TabsContent value="overtime" forceMount className="space-y-4 data-[state=inactive]:hidden">
              <Section title={t('rules.sections.overtime')} hint={t('rules.sections.overtimeHint')}>
                {rb('overtimeEnabled', 'overtimeEnabled')}
                <div className={`grid gap-3 sm:grid-cols-2 ${otEnabled ? '' : 'opacity-50'}`}>
                  {rn('overtimeStartAfterMinutes', 'overtimeStartAfterMinutes', { max: 480, hint: true })}{rn('overtimeMinBlockMinutes', 'overtimeMinBlockMinutes', { max: 480, hint: true })}
                  {roundingSelect('overtimeRoundingMinutes', OT_ROUNDING, t('rules.fields.overtimeRoundingMinutes'))}
                  {n('overtimeMaxMinutesPerDay', t('rules.fields.overtimeMaxMinutesPerDay'), { max: 1440, nullable: true, hint: t('rules.hints.overtimeMaxMinutesPerDay'), placeholder: t('rules.noLimit'), warn: 'overtimeMaxMinutesPerDay' })}
                </div>
                {rb('overtimeRequiresScheduledHours', 'overtimeRequiresScheduledHours')}
                <div className="grid gap-2 sm:grid-cols-3">{rb('countEarlyInAsOvertime', 'countEarlyInAsOvertime')}{rb('weeklyOffWorkCountsAsOvertime', 'weeklyOffWorkCountsAsOvertime')}{rb('holidayWorkCountsAsOvertime', 'holidayWorkCountsAsOvertime')}</div>
              </Section>
              {enterprise ? (
                <Section title={t('policyEditor.sections.overtimeLimits')} hint={t('policyEditor.sections.overtimeLimitsHint')} enterprise>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {n('policy.overtime.weeklyThresholdMinutes', t('policyEditor.fields.weeklyThresholdMinutes'), { min: 60, max: 10080, nullable: true, hint: t('policyEditor.hints.weeklyThresholdMinutes'), placeholder: t('policyEditor.off'), warn: 'policy.overtime.weeklyThresholdMinutes' })}
                    {n('policy.overtime.maxDailyWorkMinutes', t('policyEditor.fields.maxDailyWorkMinutes'), { min: 60, max: 1440, nullable: true, hint: t('policyEditor.hints.maxDailyWorkMinutes'), placeholder: t('rules.noLimit'), warn: 'policy.overtime.maxDailyWorkMinutes' })}
                  </div>
                  <p className="text-xs font-medium">{t('policyEditor.fields.rates')}</p>
                  <div className="grid gap-3 sm:grid-cols-4">
                    {(['regular', 'weekly', 'weeklyOff', 'holiday'] as const).map((k) => n(`policy.overtime.rates.${k}`, t(`policyEditor.rates.${k}`), { min: 1, max: 5, step: 0.05, warn: `policy.overtime.rates.${k}` }))}
                  </div>
                </Section>
              ) : null}
            </TabsContent>

            {enterprise ? (
              <TabsContent value="discipline" forceMount className="space-y-4 data-[state=inactive]:hidden">
                <Section title={t('policyEditor.sections.points')} hint={t('policyEditor.sections.pointsHint')} enterprise>
                  {b('policy.points.enabled', t('policyEditor.fields.pointsEnabled'), t('policyEditor.hints.pointsEnabled'))}
                  <div className={cn('space-y-3', !pointsOn && 'opacity-50')}>
                    <div className="grid gap-3 sm:grid-cols-4">
                      {(['late', 'veryLate', 'earlyDeparture', 'absent', 'missingPunch', 'unexcused', 'repeatedLate'] as const).map((k) => n(`policy.points.${k}`, t(`policyEditor.points.${k}`), { min: 0, max: 100, step: 0.5 }))}
                      {n('policy.points.expiryDays', t('policyEditor.fields.expiryDays'), { min: 7, max: 730, hint: t('policyEditor.hints.expiryDays') })}
                    </div>
                    <EscalationEditor control={control} register={register} errors={errors} />
                  </div>
                </Section>
              </TabsContent>
            ) : null}

            {enterprise ? (
              <TabsContent value="regularisation" forceMount className="space-y-4 data-[state=inactive]:hidden">
                <Section title={t('policyEditor.sections.regularisation')} hint={t('policyEditor.sections.regularisationHint')} enterprise>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {n('policy.regularisation.maxPerMonth', t('policyEditor.fields.maxPerMonth'), { min: 1, max: 31, nullable: true, placeholder: t('rules.noLimit') })}
                    {n('policy.regularisation.backdateDays', t('policyEditor.fields.backdateDays'), { min: 1, max: 365, nullable: true, placeholder: t('rules.noLimit'), hint: t('policyEditor.hints.backdateDays') })}
                  </div>
                </Section>
              </TabsContent>
            ) : null}

            <TabsContent value="ramadan" forceMount className="space-y-4 data-[state=inactive]:hidden">
              <Section title={t('rules.sections.ramadan')} hint={t('rules.sections.ramadanHint')}>
                <Controller control={control} name="ramadanMode.enabled" render={({ field }) => (
                  <div className="flex items-center justify-between gap-4 rounded-md border p-3"><label htmlFor="rs-ram" className="text-sm font-medium">{t('rules.fields.ramadanEnabled')}</label><Switch id="rs-ram" checked={!!field.value} onCheckedChange={field.onChange} /></div>
                )} />
                <div className={`grid gap-3 sm:grid-cols-2 ${ramadan ? '' : 'opacity-50'}`}>
                  <FormField label={tc('common.from')} htmlFor="rs-ram-from" error={errors.ramadanMode?.from?.message}><Input id="rs-ram-from" type="date" dir="ltr" disabled={!ramadan} {...register('ramadanMode.from', { setValueAs: blankToUndefined })} /></FormField>
                  <FormField label={tc('common.to')} htmlFor="rs-ram-to" error={errors.ramadanMode?.to?.message}><Input id="rs-ram-to" type="date" dir="ltr" disabled={!ramadan} {...register('ramadanMode.to', { setValueAs: blankToUndefined })} /></FormField>
                  <div className="space-y-1">
                    <FormField label={t('rules.fields.ramadanMinutes')} htmlFor="rs-ram-min" hint={t('rules.hints.ramadanMinutes')} error={errors.ramadanMode?.scheduledMinutes?.message}><Input id="rs-ram-min" type="number" min={60} max={600} dir="ltr" className="tnum" disabled={!ramadan} {...register('ramadanMode.scheduledMinutes', { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? undefined : Number(v)) })} /></FormField>
                    <FieldWarnings warnings={warningsOf('ramadanMode.scheduledMinutes')} />
                  </div>
                  <FormField label={t('rules.fields.ramadanAppliesTo')} htmlFor="rs-ram-applies" error={errors.ramadanMode?.appliesTo?.message}>
                    <Controller control={control} name="ramadanMode.appliesTo" render={({ field }) => (
                      <Select value={field.value ?? 'all'} onValueChange={field.onChange} disabled={!ramadan}><SelectTrigger id="rs-ram-applies"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('rules.ramadanAll')}</SelectItem><SelectItem value="flagged_employees">{t('rules.ramadanFlagged')}</SelectItem></SelectContent></Select>
                    )} />
                  </FormField>
                </div>
              </Section>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting}>{ruleSet ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
