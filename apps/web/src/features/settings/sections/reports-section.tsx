import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { organizationSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

const serverSchema = organizationSettingsSchema.shape.reports.unwrap();
/** The form lets an override box be blank ("use the default"); blanks are dropped before the group is PUT. */
const schema = serverSchema.extend({ codeOverrides: z.record(z.string(), z.string().trim().max(6)).default({}) });
type Values = z.input<typeof schema>;
type Output = z.output<typeof serverSchema>;

/** Statuses a tenant may rename; leave days always print the leave type's own code. Placeholders show the defaults. */
const CODE_KEYS = ['PRESENT', 'ABSENT', 'WEEKLY_OFF', 'HOLIDAY', 'HALF_DAY', 'HALF_DAY_LEAVE', 'LEAVE'] as const;
const DEFAULT_CODES: Record<(typeof CODE_KEYS)[number], string> = { PRESENT: 'PR', ABSENT: 'AB', WEEKLY_OFF: 'OF', HOLIDAY: 'HL', HALF_DAY: 'HDP', HALF_DAY_LEAVE: 'HDL', LEAVE: 'LV' };
const NOTATIONS = ['h.mm', 'hh:mm'] as const;
const FORMATS = ['pdf', 'xlsx', 'csv'] as const;

export default function ReportsSection() {
  const q = useSettingsGroup('reports');
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <ReportsForm key={JSON.stringify(q.data)} initial={q.data} />;
}

export function ReportsForm({ initial, onSaved }: { initial: OrganizationSettings['reports']; onSaved?: (v: Output) => void }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<Values, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { hoursNotation: 'h.mm', defaultFormat: 'pdf', showLegend: true, ...initial, codeOverrides: initial.codeOverrides ?? {} }, disabled: readOnly });
  const { register, control, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => {
    const codeOverrides = Object.fromEntries(Object.entries(values.codeOverrides ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
    const payload: Output = { ...values, codeOverrides };
    try { await putGroup.mutateAsync({ group: 'reports', value: payload }); toast.success(t('saved')); form.reset({ ...values, codeOverrides }); onSaved?.(payload); } catch (e) { toastError(e); }
  });
  return (
    <SettingsSection title={t('reports.title')} description={t('reports.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('reports.hoursNotation')} htmlFor="rep-notation" hint={t('reports.hoursNotationHint')} error={errors.hoursNotation?.message}>
          <Controller control={control} name="hoursNotation" render={({ field }) => (
            <Select value={field.value ?? 'h.mm'} onValueChange={field.onChange} disabled={readOnly}>
              <SelectTrigger id="rep-notation"><SelectValue /></SelectTrigger>
              <SelectContent>{NOTATIONS.map((n) => <SelectItem key={n} value={n}>{t(`reports.notation.${n}`)}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </FormField>
        <FormField label={t('reports.defaultFormat')} htmlFor="rep-format" hint={t('reports.defaultFormatHint')} error={errors.defaultFormat?.message}>
          <Controller control={control} name="defaultFormat" render={({ field }) => (
            <Select value={field.value ?? 'pdf'} onValueChange={field.onChange} disabled={readOnly}>
              <SelectTrigger id="rep-format"><SelectValue /></SelectTrigger>
              <SelectContent>{FORMATS.map((f) => <SelectItem key={f} value={f}>{f.toUpperCase()}</SelectItem>)}</SelectContent>
            </Select>
          )} />
        </FormField>
      </div>
      <Controller control={control} name="showLegend" render={({ field }) => <SwitchRow id="rep-legend" label={t('reports.showLegend')} hint={t('reports.showLegendHint')} control={<Switch id="rep-legend" checked={field.value ?? true} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t('reports.codes')}</legend>
        <p className="text-xs text-muted-foreground">{t('reports.codesHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CODE_KEYS.map((k) => (
            <FormField key={k} label={t(`reports.code.${k}`)} htmlFor={`rep-code-${k}`} error={(errors.codeOverrides as Record<string, { message?: string }> | undefined)?.[k]?.message}>
              <Input id={`rep-code-${k}`} dir="ltr" maxLength={6} className="font-mono uppercase" placeholder={DEFAULT_CODES[k]} {...register(`codeOverrides.${k}`)} />
            </FormField>
          ))}
        </div>
      </fieldset>
    </SettingsSection>
  );
}
