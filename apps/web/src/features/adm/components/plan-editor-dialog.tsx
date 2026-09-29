import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { MODULE_KEYS, PLAN_LIMIT_KEYS, planPriceFor, quoteSubscription, type CreatePlanInput, type PlatformPlanDto } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Switch, Textarea } from '@/components/ui';
import { fmtMoney } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useBillingMutations } from '../billing-api';

const num = z.number().min(0).max(10_000_000).optional();
const intOpt = (max: number) => z.number().int().min(0).max(max).optional();
const formSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,31}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  sortOrder: z.number().int().min(0).max(10_000),
  trialDays: z.number().int().min(0).max(365),
  isActive: z.boolean(),
  isCustom: z.boolean(),
  includedUsers: z.number().int().min(1).max(100_000).optional(),
  monthly: num, yearly: num, extraUserMonthly: num, extraUserYearly: num,
  limits: z.object(Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, intOpt(1_000_000_000)])) as Record<(typeof PLAN_LIMIT_KEYS)[number], ReturnType<typeof intOpt>>),
  modules: z.array(z.enum(MODULE_KEYS)),
  features: z.string().trim().max(1000),
}).refine((v) => (v.monthly === undefined) === (v.yearly === undefined), { message: 'Give both the monthly and the yearly price, or neither.', path: ['yearly'] });
type Values = z.infer<typeof formSchema>;

const numberInput = { setValueAs: (v: unknown) => (v === '' || v === null || v === undefined ? undefined : Number(v)) };

/** Create or edit a plan (Flowza Finance EditPlanModal parity): prices per cycle, included users, extra-user price, limits, modules. */
export function PlanEditorDialog({ plan, currency, open, onOpenChange }: { plan: PlatformPlanDto | null; currency: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { createPlan, updatePlan } = useBillingMutations();
  const price = plan ? planPriceFor(plan.prices, currency) : null;
  const limits = (plan?.limits ?? {}) as Record<string, unknown>;
  const form = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      key: plan?.key ?? '', name: plan?.name ?? '', description: plan?.description ?? '', sortOrder: plan?.sortOrder ?? 100, trialDays: plan?.trialDays ?? 0,
      isActive: plan?.isActive ?? true, isCustom: plan?.isCustom ?? false, includedUsers: plan?.includedUsers ?? undefined,
      monthly: price?.monthly, yearly: price?.yearly, extraUserMonthly: price?.extraUserMonthly, extraUserYearly: price?.extraUserYearly,
      limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, typeof limits[k] === 'number' ? (limits[k] as number) : undefined])) as Values['limits'],
      modules: (plan?.modules ?? []).filter((m): m is (typeof MODULE_KEYS)[number] => (MODULE_KEYS as readonly string[]).includes(m)),
      features: (plan?.features ?? []).join(', '),
    },
  });
  const { register, control, formState: { errors } } = form;
  const v = useWatch({ control });
  const preview = v.monthly !== undefined && v.yearly !== undefined && !Number.isNaN(v.monthly) && !Number.isNaN(v.yearly)
    ? quoteSubscription({ prices: { [currency]: { monthly: v.monthly, yearly: v.yearly, extraUserMonthly: v.extraUserMonthly ?? 0, extraUserYearly: v.extraUserYearly ?? 0 } }, includedUsers: v.includedUsers ?? null, currency, cycle: 'yearly', seats: v.includedUsers ?? null })
    : null;
  const discount = v.monthly && v.yearly ? Math.round((1 - v.yearly / (v.monthly * 12)) * 100) : null;
  const submit = form.handleSubmit((values) => {
    const input: CreatePlanInput = {
      key: values.key, name: values.name, description: values.description || null, sortOrder: values.sortOrder, trialDays: values.trialDays,
      isActive: values.isActive, isCustom: values.isCustom, includedUsers: values.includedUsers ?? null, modules: values.modules,
      features: values.features.split(',').map((f) => f.trim()).filter(Boolean),
      limits: Object.fromEntries(Object.entries(values.limits).filter(([, n]) => n !== undefined)) as CreatePlanInput['limits'],
      prices: values.monthly !== undefined && values.yearly !== undefined
        ? { ...(plan?.prices as CreatePlanInput['prices']), [currency]: { monthly: values.monthly, yearly: values.yearly, extraUserMonthly: values.extraUserMonthly ?? 0, extraUserYearly: values.extraUserYearly ?? 0 } }
        : {},
    };
    const done = { onSuccess: () => { toast.success(t('plans.saved')); onOpenChange(false); }, onError: toastError };
    if (plan) { const { key: _k, ...rest } = input; updatePlan.mutate({ key: plan.key, input: rest }, done); } else createPlan.mutate(input, done);
  });
  const moneyField = (name: 'monthly' | 'yearly' | 'extraUserMonthly' | 'extraUserYearly') => (
    <FormField label={`${t(`plans.fields.${name}`)} (${currency})`} htmlFor={`plan-${name}`} error={errors[name]?.message}>
      <Input id={`plan-${name}`} type="number" min={0} step="0.001" dir="ltr" {...register(name, numberInput)} />
    </FormField>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{plan ? t('plans.editTitle', { name: plan.name }) : t('plans.newTitle')}</DialogTitle><DialogDescription>{t('plans.editorHint')}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-5" noValidate>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label={t('plans.fields.name')} htmlFor="plan-name" required error={errors.name?.message}><Input id="plan-name" {...register('name')} /></FormField>
            <FormField label={t('plans.fields.key')} htmlFor="plan-key" required hint={plan ? t('plans.keyFixed') : t('plans.keyHint')} error={errors.key?.message}><Input id="plan-key" dir="ltr" className="font-mono" disabled={!!plan} {...register('key')} /></FormField>
            <FormField label={t('plans.fields.sortOrder')} htmlFor="plan-sort"><Input id="plan-sort" type="number" dir="ltr" {...register('sortOrder', { valueAsNumber: true })} /></FormField>
            <FormField label={t('plans.fields.trialDays')} htmlFor="plan-trial" hint={t('plans.trialHint')}><Input id="plan-trial" type="number" min={0} max={365} dir="ltr" {...register('trialDays', { valueAsNumber: true })} /></FormField>
          </section>
          <FormField label={t('plans.fields.description')} htmlFor="plan-desc"><Textarea id="plan-desc" rows={2} {...register('description')} /></FormField>

          <section className="space-y-3 rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{t('plans.pricing')}</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <FormField label={t('plans.fields.includedUsers')} htmlFor="plan-included" hint={t('plans.includedHint')} error={errors.includedUsers?.message}><Input id="plan-included" type="number" min={1} dir="ltr" {...register('includedUsers', numberInput)} /></FormField>
              {moneyField('monthly')}{moneyField('yearly')}{moneyField('extraUserMonthly')}{moneyField('extraUserYearly')}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="plan-preview">
              {preview ? t('plans.preview', { amount: fmtMoney(preview.amount, currency), users: preview.seats || '—', perUser: fmtMoney(preview.perUserMonthly, currency) }) : t('plans.noPrice')}
              {discount !== null && discount > 0 ? ` · ${t('plans.yearlyDiscount', { pct: discount })}` : null}
            </p>
            <div className="flex flex-wrap gap-6">
              <Controller control={control} name="isCustom" render={({ field }) => <label className="flex items-center gap-2 text-sm"><Switch checked={field.value} onCheckedChange={field.onChange} /> {t('plans.fields.isCustom')}</label>} />
              <Controller control={control} name="isActive" render={({ field }) => <label className="flex items-center gap-2 text-sm"><Switch checked={field.value} onCheckedChange={field.onChange} /> {t('plans.fields.isActive')}</label>} />
            </div>
          </section>

          <section className="space-y-2 rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{t('plans.modulesTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('plans.modulesHint')}</p>
            <Controller control={control} name="modules" render={({ field }) => (
              <div className="grid gap-2 sm:grid-cols-2">
                {MODULE_KEYS.map((m) => (
                  <label key={m} className="flex items-start gap-2 rounded-md p-1.5 text-sm hover:bg-muted/50">
                    <Checkbox checked={field.value.includes(m)} onCheckedChange={(c) => field.onChange(c ? [...field.value, m] : field.value.filter((x) => x !== m))} className="mt-0.5" />
                    <span><span className="font-medium">{tc(`modules.${m}.name`)}</span><span className="block text-xs text-muted-foreground">{tc(`modules.${m}.description`)}</span></span>
                  </label>
                ))}
              </div>
            )} />
          </section>

          <section className="space-y-3 rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{t('plans.limitsTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('plans.limitsHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {PLAN_LIMIT_KEYS.map((k) => (
                <FormField key={k} label={t(`plans.limitKeys.${k}`)} htmlFor={`plan-limit-${k}`}><Input id={`plan-limit-${k}`} type="number" min={0} dir="ltr" {...register(`limits.${k}`, numberInput)} /></FormField>
              ))}
            </div>
            <FormField label={t('plans.fields.features')} htmlFor="plan-features" hint={t('plans.featuresHint')}><Input id="plan-features" dir="ltr" className="font-mono text-xs" {...register('features')} /></FormField>
          </section>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={createPlan.isPending || updatePlan.isPending}>{plan ? tc('common.save') : tc('common.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
