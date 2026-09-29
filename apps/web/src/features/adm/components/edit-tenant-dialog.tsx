import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { addressSchema, contactSchema, countryCodeSchema, currencyCodeSchema, timezoneSchema, weeklyOffDaysSchema, type PlatformOrganizationDto, type UpdateOrganizationInput } from '@flowza/contracts';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { TimezoneSelect } from '@/features/organization/components/timezone-select';
import { useAdmMutations } from '../api';

/** Every field is a string in the form; empty strings drop out of contact / address before the PATCH. */
const formSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120),
  countryCode: countryCodeSchema,
  timezone: timezoneSchema,
  currencyCode: currencyCodeSchema,
  locale: z.enum(['en', 'ar']),
  weeklyOffDays: weeklyOffDaysSchema,
  contact: z.object({ name: z.string().max(200), email: z.string().max(254), phone: z.string().max(32), website: z.string().max(500) }),
  address: z.object({ line1: z.string().max(200), line2: z.string().max(200), city: z.string().max(100), region: z.string().max(100), postalCode: z.string().max(20), country: z.string().max(2) }),
}).superRefine((v, ctx) => {
  const contact = contactSchema.safeParse(compact(v.contact));
  if (!contact.success) for (const i of contact.error.issues) ctx.addIssue({ code: 'custom', path: ['contact', ...i.path.map(String)], message: i.message });
  const address = addressSchema.safeParse(compact(v.address));
  if (!address.success) for (const i of address.error.issues) ctx.addIssue({ code: 'custom', path: ['address', ...i.path.map(String)], message: i.message });
});
type Values = z.infer<typeof formSchema>;

function compact<T extends Record<string, string>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== '')) as Partial<T>;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function EditTenantDialog({ org, open, onOpenChange }: { org: PlatformOrganizationDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { updateDetails } = useAdmMutations();
  const c = org.contact as Record<string, unknown>;
  const a = org.address as Record<string, unknown>;
  const form = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      legalName: org.legalName, displayName: org.displayName, countryCode: org.countryCode, timezone: org.timezone, currencyCode: org.currencyCode,
      locale: org.locale === 'ar' ? 'ar' : 'en', weeklyOffDays: org.weeklyOffDays,
      contact: { name: str(c['name']), email: str(c['email']), phone: str(c['phone']), website: str(c['website']) },
      address: { line1: str(a['line1']), line2: str(a['line2']), city: str(a['city']), region: str(a['region']), postalCode: str(a['postalCode']), country: str(a['country']) },
    },
  });
  const { register, control, formState: { errors } } = form;
  const submit = form.handleSubmit((v) => {
    const address = compact(v.address);
    if (address.country) address.country = address.country.toUpperCase();
    const input: UpdateOrganizationInput = {
      legalName: v.legalName, displayName: v.displayName, countryCode: v.countryCode, timezone: v.timezone, currencyCode: v.currencyCode, locale: v.locale,
      weeklyOffDays: [...v.weeklyOffDays].sort(), contact: compact(v.contact), address,
    };
    updateDetails.mutate({ id: org.id, input }, { onSuccess: () => { toast.success(t('tenant.saved')); onOpenChange(false); }, onError: toastError });
  });
  const field = (name: string, label: string, error?: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <FormField label={label} htmlFor={`tenant-${name}`} error={error}>
      <Input id={`tenant-${name}`} {...register(name as keyof Values)} aria-invalid={!!error} {...props} />
    </FormField>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('tenant.editDetails')}</DialogTitle><DialogDescription>{t('tenant.editHint')}</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="space-y-5" noValidate>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('tenant.sections.identity')}</legend>
            {field('legalName', t('tenant.fields.legalName'), errors.legalName?.message)}
            {field('displayName', t('tenant.fields.displayName'), errors.displayName?.message)}
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('tenant.sections.locale')}</legend>
            {field('countryCode', t('tenant.fields.country'), errors.countryCode?.message, { dir: 'ltr', maxLength: 2, className: 'uppercase' })}
            {field('currencyCode', t('tenant.fields.currency'), errors.currencyCode?.message, { dir: 'ltr', maxLength: 3, className: 'uppercase' })}
            <FormField label={t('tenant.fields.timezone')} htmlFor="tenant-timezone" error={errors.timezone?.message}>
              <Controller control={control} name="timezone" render={({ field: f }) => <TimezoneSelect id="tenant-timezone" value={f.value} onChange={f.onChange} />} />
            </FormField>
            <FormField label={t('tenant.fields.locale')} htmlFor="tenant-locale">
              <Controller control={control} name="locale" render={({ field: f }) => (
                <Select value={f.value} onValueChange={f.onChange}><SelectTrigger id="tenant-locale"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="en">{t('tenant.locales.en')}</SelectItem><SelectItem value="ar">{t('tenant.locales.ar')}</SelectItem></SelectContent>
                </Select>
              )} />
            </FormField>
            <div className="sm:col-span-2">
              <Label className="mb-1.5 block">{t('tenant.fields.weeklyOff')}</Label>
              <Controller control={control} name="weeklyOffDays" render={({ field: f }) => (
                <div className="flex flex-wrap gap-3">
                  {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                    <label key={d} className="inline-flex items-center gap-1.5 text-sm">
                      <Checkbox checked={f.value.includes(d)} onCheckedChange={(on) => f.onChange(on ? [...f.value, d] : f.value.filter((x) => x !== d))} aria-label={t(`tenant.days.${d}`)} />
                      {t(`tenant.days.${d}`)}
                    </label>
                  ))}
                </div>
              )} />
            </div>
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('tenant.sections.contact')}</legend>
            {field('contact.name', t('tenant.fields.contactName'), errors.contact?.name?.message)}
            {field('contact.email', t('tenant.fields.contactEmail'), errors.contact?.email?.message, { type: 'email', dir: 'ltr' })}
            {field('contact.phone', t('tenant.fields.contactPhone'), errors.contact?.phone?.message, { dir: 'ltr', inputMode: 'tel' })}
            {field('contact.website', t('tenant.fields.website'), errors.contact?.website?.message, { dir: 'ltr', placeholder: 'https://' })}
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('tenant.sections.address')}</legend>
            {field('address.line1', t('tenant.fields.line1'), errors.address?.line1?.message)}
            {field('address.line2', t('tenant.fields.line2'), errors.address?.line2?.message)}
            {field('address.city', t('tenant.fields.city'), errors.address?.city?.message)}
            {field('address.region', t('tenant.fields.region'), errors.address?.region?.message)}
            {field('address.postalCode', t('tenant.fields.postalCode'), errors.address?.postalCode?.message, { dir: 'ltr' })}
            {field('address.country', t('tenant.fields.addressCountry'), errors.address?.country?.message, { dir: 'ltr', maxLength: 2, className: 'uppercase' })}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={updateDetails.isPending}>{tc('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
