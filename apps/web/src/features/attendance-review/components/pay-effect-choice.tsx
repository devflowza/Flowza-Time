import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { AR_NS } from '../i18n';
import { PAY_EFFECTS, payEffectKey, type PayEffect } from '../model';

/**
 * The pay effect of rejecting a reason: no deduction, half a day or a full day (charged to a paid leave balance first, then
 * as loss of pay, per the organisation's rules). Native radios: keyboard- and screen-reader friendly.
 */
export function PayEffectChoice({ value, onChange, name = 'pay-effect' }: { value: PayEffect; onChange: (v: PayEffect) => void; name?: string }) {
  const { t } = useTranslation(AR_NS);
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{t('review.payEffect')}</legend>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t('review.payEffect')}>
        {PAY_EFFECTS.map((p) => (
          <label key={p} className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-md border px-2 py-2 text-sm transition-colors', value === p ? 'border-primary bg-accent font-medium' : 'hover:bg-accent/40')}>
            <input type="radio" name={name} className="sr-only" checked={value === p} onChange={() => onChange(p)} aria-label={t(`review.payEffects.${payEffectKey(p)}`)} />
            <span aria-hidden>{t(`review.payEffects.${payEffectKey(p)}`)}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('review.payEffectHint')}</p>
    </fieldset>
  );
}
