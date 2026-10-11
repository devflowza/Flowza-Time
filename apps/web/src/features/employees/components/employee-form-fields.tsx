import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, GENDERS, type createEmployeeSchema } from '@flowza/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useDepartmentOptions, useDesignationOptions } from '@/features/organization/lookups';
import { BranchPicker } from '@/features/organization/components/branch-picker';
import { blankToUndefined } from '@/features/organization/form-utils';
import { WeeklyOffToggles } from '@/features/organization/components/weekly-off-toggles';
import { LocationPicker } from '@/features/locations/components/location-picker';
import { useLocationTree } from '@/features/locations/use-location-tree';
import { useEmployeeOptions } from '../api';

/** Form values are the *input* side of the contract schema (defaults not yet applied). Shared by create and edit. */
export type EmployeeFormValues = z.input<typeof createEmployeeSchema> & { exitDate?: string | null };

/** A work location is a place (site, floor, zone…) of the employee's branch (docs/locations.md). */
const PLACE_ROLES = ['place'] as const;

export function EmployeeFormFields({ form, mode, excludeEmployeeId }: { form: UseFormReturn<EmployeeFormValues, unknown, unknown>; mode: 'create' | 'edit'; excludeEmployeeId?: string }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const { register, control, formState: { errors } } = form;
  const branchId = useWatch({ control, name: 'branchId' });
  const workLocationId = useWatch({ control, name: 'workLocationId' });
  const managerId = useWatch({ control, name: 'managerEmployeeId' });
  const secondaryManagerId = useWatch({ control, name: 'secondaryManagerEmployeeId' });
  // the work location only exists for organisations whose branches hold places (sites, floors, zones…)
  const locations = useLocationTree();
  const savedWorkLocation = form.formState.defaultValues?.workLocationId ?? null;
  // an archived place stays readable on the record that still points at it (it is not in the active tree)
  const archivedWorkLocation = !!savedWorkLocation && locations.byId.size > 0 && !locations.byId.has(savedWorkLocation);
  const workLocationPath = locations.labelOf(workLocationId, { fromBranch: true });
  // Cleared = null when editing: a Controller set to `undefined` falls back to (and shows) the saved default; the PATCH
  // diff turns it into null anyway. A new record just leaves the field out.
  const noWorkLocation = mode === 'edit' ? null : undefined;
  const departments = useDepartmentOptions(branchId || undefined);
  const designations = useDesignationOptions();
  const managers = useEmployeeOptions();
  const secondaryManagers = useEmployeeOptions();
  // an employee is never their own manager, and the two managers are two different people (DB check constraint)
  const managerOptions = managers.options.filter((o) => o.value !== excludeEmployeeId && o.value !== secondaryManagerId);
  const secondaryManagerOptions = secondaryManagers.options.filter((o) => o.value !== excludeEmployeeId && o.value !== managerId);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>{t('form.basic')}</CardTitle><CardDescription>{t('form.basicHint')}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label={t('fields.employeeNumber')} htmlFor="emp-number" required error={errors.employeeNumber?.message} hint={t('fields.employeeNumberHint')}>
            <Input id="emp-number" dir="ltr" className="font-mono" {...register('employeeNumber')} aria-invalid={!!errors.employeeNumber} disabled={mode === 'edit'} />
          </FormField>
          <FormField label={t('fields.firstName')} htmlFor="emp-first" required error={errors.firstName?.message}>
            <Input id="emp-first" {...register('firstName')} aria-invalid={!!errors.firstName} autoComplete="off" />
          </FormField>
          <FormField label={t('fields.middleName')} htmlFor="emp-middle" optional error={errors.middleName?.message}>
            <Input id="emp-middle" {...register('middleName', { setValueAs: blankToUndefined })} />
          </FormField>
          <FormField label={t('fields.lastName')} htmlFor="emp-last" required error={errors.lastName?.message}>
            <Input id="emp-last" {...register('lastName')} aria-invalid={!!errors.lastName} />
          </FormField>
          <FormField label={t('fields.displayName')} htmlFor="emp-display" optional error={errors.displayName?.message} hint={t('fields.displayNameHint')}>
            <Input id="emp-display" {...register('displayName', { setValueAs: blankToUndefined })} />
          </FormField>
          <FormField label={t('fields.displayNameAr')} htmlFor="emp-display-ar" optional error={errors.displayNameAr?.message}>
            <Input id="emp-display-ar" dir="rtl" {...register('displayNameAr', { setValueAs: blankToUndefined })} />
          </FormField>
          <FormField label={t('fields.gender')} htmlFor="emp-gender" error={errors.gender?.message}>
            <Controller control={control} name="gender" render={({ field }) => (
              <Select value={field.value ?? 'unspecified'} onValueChange={field.onChange}>
                <SelectTrigger id="emp-gender"><SelectValue /></SelectTrigger>
                <SelectContent>{GENDERS.map((g) => <SelectItem key={g} value={g}>{t(`gender.${g}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <FormField label={t('fields.dateOfBirth')} htmlFor="emp-dob" optional error={errors.dateOfBirth?.message}>
            <Input id="emp-dob" type="date" dir="ltr" {...register('dateOfBirth', { setValueAs: blankToUndefined })} aria-invalid={!!errors.dateOfBirth} />
          </FormField>
          <FormField label={t('fields.nationality')} htmlFor="emp-nat" optional error={errors.nationalityCode?.message} hint={t('fields.nationalityHint')}>
            <Input id="emp-nat" dir="ltr" maxLength={2} className="uppercase" {...register('nationalityCode', { setValueAs: blankToUndefined })} aria-invalid={!!errors.nationalityCode} />
          </FormField>
          <FormField label={t('fields.email')} htmlFor="emp-email" optional error={errors.email?.message}>
            <Input id="emp-email" type="email" dir="ltr" autoComplete="off" {...register('email', { setValueAs: blankToUndefined })} aria-invalid={!!errors.email} />
          </FormField>
          <FormField label={t('fields.phone')} htmlFor="emp-phone" optional error={errors.phone?.message}>
            <Input id="emp-phone" type="tel" dir="ltr" autoComplete="off" {...register('phone', { setValueAs: blankToUndefined })} aria-invalid={!!errors.phone} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('form.employment')}</CardTitle><CardDescription>{mode === 'edit' ? t('form.employmentEditHint') : t('form.employmentHint')}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label={t('fields.joiningDate')} htmlFor="emp-joining" required error={errors.joiningDate?.message}>
            <Input id="emp-joining" type="date" dir="ltr" {...register('joiningDate')} aria-invalid={!!errors.joiningDate} />
          </FormField>
          {mode === 'edit' ? (
            <FormField label={t('fields.exitDate')} htmlFor="emp-exit" optional error={errors.exitDate?.message}>
              <Input id="emp-exit" type="date" dir="ltr" {...register('exitDate', { setValueAs: (v: unknown) => (v === '' ? null : v) })} aria-invalid={!!errors.exitDate} />
            </FormField>
          ) : null}
          <FormField label={t('fields.employmentStatus')} htmlFor="emp-status" error={errors.employmentStatus?.message}>
            <Controller control={control} name="employmentStatus" render={({ field }) => (
              <Select value={field.value ?? 'active'} onValueChange={field.onChange}>
                <SelectTrigger id="emp-status"><SelectValue /></SelectTrigger>
                <SelectContent>{EMPLOYMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`employmentStatus.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <FormField label={t('fields.employmentType')} htmlFor="emp-type" error={errors.employmentType?.message}>
            <Controller control={control} name="employmentType" render={({ field }) => (
              <Select value={field.value ?? 'full_time'} onValueChange={field.onChange}>
                <SelectTrigger id="emp-type"><SelectValue /></SelectTrigger>
                <SelectContent>{EMPLOYMENT_TYPES.map((s) => <SelectItem key={s} value={s}>{t(`employmentType.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
          <FormField label={tc('common.branch')} htmlFor="emp-branch" required error={errors.branchId?.message}>
            <Controller control={control} name="branchId" render={({ field }) => (
              <BranchPicker id="emp-branch" value={field.value} placeholder={t('fields.selectBranch')} aria-invalid={!!errors.branchId}
                onChange={(v) => {
                  // a place belongs to one branch: another branch clears the work location (the edit PATCH sends null)
                  if ((v ?? '') !== field.value && form.getValues('workLocationId')) form.setValue('workLocationId', noWorkLocation, { shouldDirty: true });
                  field.onChange(v ?? '');
                }} />
            )} />
          </FormField>
          {locations.hasPlaceLevels || savedWorkLocation ? (
            <FormField label={t('fields.workLocation')} htmlFor="emp-work-location" optional error={errors.workLocationId?.message} hint={workLocationPath || t('fields.workLocationHint')}>
              <Controller control={control} name="workLocationId" render={({ field }) => (
                <LocationPicker id="emp-work-location" value={field.value ?? null} roles={PLACE_ROLES} branchId={branchId || null} includeArchived={archivedWorkLocation} disabled={field.disabled} onChange={(v) => field.onChange(v ?? noWorkLocation)} aria-invalid={!!errors.workLocationId} />
              )} />
            </FormField>
          ) : null}
          <FormField label={tc('common.department')} htmlFor="emp-dept" optional error={errors.departmentId?.message}>
            <Controller control={control} name="departmentId" render={({ field }) => <Combobox id="emp-dept" value={field.value} onChange={(v) => field.onChange(v ?? undefined)} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.none')} />} />
          </FormField>
          <FormField label={t('fields.designation')} htmlFor="emp-desig" optional error={errors.designationId?.message}>
            <Controller control={control} name="designationId" render={({ field }) => <Combobox id="emp-desig" value={field.value} onChange={(v) => field.onChange(v ?? undefined)} options={designations.options} loading={designations.isLoading} clearable placeholder={tc('common.none')} />} />
          </FormField>
          <FormField label={t('fields.manager')} htmlFor="emp-manager" optional error={errors.managerEmployeeId?.message} hint={t('fields.managerHint')}>
            <Controller control={control} name="managerEmployeeId" render={({ field }) => <Combobox id="emp-manager" value={field.value} onChange={(v) => field.onChange(v ?? undefined)} options={managerOptions} onSearch={managers.setSearch} loading={managers.isLoading} clearable placeholder={tc('common.none')} />} />
          </FormField>
          <FormField label={t('fields.secondaryManager')} htmlFor="emp-secondary-manager" optional error={errors.secondaryManagerEmployeeId?.message} hint={t('fields.secondaryManagerHint')}>
            <Controller control={control} name="secondaryManagerEmployeeId" render={({ field }) => <Combobox id="emp-secondary-manager" value={field.value} onChange={(v) => field.onChange(v ?? undefined)} options={secondaryManagerOptions} onSearch={secondaryManagers.setSearch} loading={secondaryManagers.isLoading} clearable placeholder={tc('common.none')} />} />
          </FormField>
          <FormField label={t('fields.weeklyOffDays')} htmlFor="emp-weekly" optional hint={t('fields.weeklyOffDaysHint')} className="sm:col-span-2 lg:col-span-3">
            <Controller control={control} name="weeklyOffDays" render={({ field }) => <WeeklyOffToggles value={field.value} onChange={(days) => field.onChange(days.length ? days : undefined)} ariaLabel={t('fields.weeklyOffDays')} />} />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('form.device')}</CardTitle><CardDescription>{t('form.deviceHint')}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* blank auto-assigns on create; an existing employee always keeps an id, so emptying it is a validation error, not a PATCH null */}
          <FormField label={t('fields.deviceUserId')} htmlFor="emp-device-id" optional={mode === 'create'} required={mode === 'edit'} error={errors.deviceUserId?.message} hint={mode === 'create' ? t('fields.deviceUserIdAuto') : t('fields.deviceUserIdEditHint')}>
            <Input id="emp-device-id" dir="ltr" className="font-mono" placeholder={mode === 'create' ? t('fields.autoAssigned') : undefined} {...register('deviceUserId', mode === 'create' ? { setValueAs: blankToUndefined } : undefined)} aria-invalid={!!errors.deviceUserId} />
          </FormField>
          <FormField label={t('fields.cardNumber')} htmlFor="emp-card" optional error={errors.cardNumber?.message}>
            <Input id="emp-card" dir="ltr" className="font-mono" {...register('cardNumber', { setValueAs: blankToUndefined })} aria-invalid={!!errors.cardNumber} />
          </FormField>
          <FormField label={t('fields.pin')} htmlFor="emp-pin" optional error={errors.pin?.message} hint={t('fields.pinHint')}>
            <Input id="emp-pin" dir="ltr" type="password" inputMode="numeric" autoComplete="new-password" className="font-mono tracking-widest" {...register('pin', { setValueAs: blankToUndefined })} aria-invalid={!!errors.pin} />
          </FormField>
        </CardContent>
      </Card>
    </div>
  );
}

