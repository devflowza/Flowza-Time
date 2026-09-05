import { useTranslation } from 'react-i18next';
import type { ProviderConfigField } from '@flowza/contracts';
import { FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import type { ConfigValue, ConfigValues } from './provider-config';

interface Props {
  fields: ProviderConfigField[];
  values: ConfigValues;
  onChange: (next: ConfigValues) => void;
  errors?: Record<string, string>;
  /** Masked stored values (****abcd) shown as placeholders for secret fields when re-entering credentials. */
  masked?: Record<string, unknown>;
  /** Render only secret (or only non-secret) fields. */
  only?: 'secret' | 'plain';
  idPrefix?: string;
  disabled?: boolean;
}

/**
 * Dynamic form driven by the provider's `configSchema`. Secret fields (or type password) render as password inputs and
 * are never echoed back; select / boolean / number / url / text map to the matching control.
 */
export function ProviderConfigForm({ fields, values, onChange, errors = {}, masked, only, idPrefix = 'cfg', disabled }: Props) {
  const { t } = useTranslation('devices');
  const visible = fields.filter((f) => (only === 'secret' ? f.secret || f.type === 'password' : only === 'plain' ? !(f.secret || f.type === 'password') : true));
  if (visible.length === 0) return <p className="text-sm text-muted-foreground">{t('wizard.noConfig')}</p>;
  const set = (key: string, v: ConfigValue | undefined) => { const next = { ...values }; if (v === undefined) delete next[key]; else next[key] = v; onChange(next); };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {visible.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const secret = f.secret || f.type === 'password';
        const err = errors[f.key] ? t(`wizard.configErrors.${errors[f.key]}`) : undefined;
        const maskedValue = masked && typeof masked[f.key] === 'string' ? (masked[f.key] as string) : undefined;
        const hint = maskedValue ? t('wizard.maskedHint', { masked: maskedValue }) : f.help;
        const raw = values[f.key];
        if (f.type === 'boolean') {
          return (
            <FormField key={f.key} label={f.label} htmlFor={id} hint={f.help} error={err} className="sm:col-span-2">
              <div className="flex items-center gap-3">
                <Switch id={id} checked={raw === true || (raw === undefined && f.default === true)} onCheckedChange={(v) => set(f.key, v)} disabled={disabled} aria-invalid={!!err} />
                <span className="text-sm text-muted-foreground">{raw === true || (raw === undefined && f.default === true) ? t('wizard.enabled') : t('wizard.disabled')}</span>
              </div>
            </FormField>
          );
        }
        if (f.type === 'select') {
          const current = raw !== undefined ? String(raw) : f.default !== undefined ? String(f.default) : '';
          return (
            <FormField key={f.key} label={f.label} htmlFor={id} required={f.required} hint={f.help} error={err}>
              <Select value={current} onValueChange={(v) => set(f.key, v)} disabled={disabled}>
                <SelectTrigger id={id} aria-invalid={!!err}><SelectValue placeholder={t('wizard.selectPlaceholder')} /></SelectTrigger>
                <SelectContent>{(f.options ?? []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          );
        }
        return (
          <FormField key={f.key} label={f.label} htmlFor={id} required={f.required && !maskedValue} hint={hint} error={err} className={f.type === 'url' ? 'sm:col-span-2' : undefined}>
            <Input
              id={id} dir="ltr" disabled={disabled} aria-invalid={!!err}
              type={secret ? 'password' : f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
              autoComplete={secret ? 'new-password' : 'off'} inputMode={f.type === 'number' ? 'decimal' : undefined}
              value={raw === undefined ? '' : String(raw)}
              placeholder={maskedValue ?? (f.default !== undefined ? String(f.default) : f.type === 'url' ? 'https://' : undefined)}
              onChange={(e) => set(f.key, e.target.value === '' ? undefined : e.target.value)}
            />
          </FormField>
        );
      })}
    </div>
  );
}
