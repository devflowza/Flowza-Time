import { useTranslation } from 'react-i18next';
import { Input, Label } from '@/components/ui';

/** Native date inputs (locale/RTL friendly, accessible) for from/to filters; values are YYYY-MM-DD. */
export function DateRange({ from, to, onChange, idPrefix = 'range' }: { from?: string; to?: string; onChange: (next: { from?: string; to?: string }) => void; idPrefix?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-from`} className="text-xs text-muted-foreground">{t('common.from')}</Label>
        <Input id={`${idPrefix}-from`} type="date" value={from ?? ''} max={to} onChange={(e) => onChange({ from: e.target.value || undefined, to })} className="h-8 w-[150px]" dir="ltr" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-to`} className="text-xs text-muted-foreground">{t('common.to')}</Label>
        <Input id={`${idPrefix}-to`} type="date" value={to ?? ''} min={from} onChange={(e) => onChange({ from, to: e.target.value || undefined })} className="h-8 w-[150px]" dir="ltr" />
      </div>
    </div>
  );
}
