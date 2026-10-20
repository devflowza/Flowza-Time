import { useTranslation } from 'react-i18next';
import { LayoutTemplate } from 'lucide-react';
import { ROLE_TEMPLATE_KEYS, type RoleTemplateKey } from '@flowza/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * "Start from a template" on the new-role page: Employee Relations, Line manager, HR viewer (`ROLE_TEMPLATES`) or blank. Picking
 * one only pre-fills the permission matrix below it; the caller applies the selection (it owns the form).
 */
export function RoleTemplatePicker({ value, onPick }: { value: RoleTemplateKey | null; onPick: (key: RoleTemplateKey | null) => void }) {
  const { t } = useTranslation('users');
  const options: Array<RoleTemplateKey | null> = [null, ...ROLE_TEMPLATE_KEYS];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><LayoutTemplate className="size-4 text-muted-foreground" aria-hidden /> {t('roles.templates.title')}</CardTitle>
        <CardDescription>{t('roles.templates.hint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div role="radiogroup" aria-label={t('roles.templates.title')} className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {options.map((key) => {
            const selected = value === key;
            return (
              <button key={key ?? 'blank'} type="button" role="radio" aria-checked={selected} onClick={() => onPick(key)}
                className={cn('rounded-lg border p-3 text-start transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', selected && 'border-primary bg-accent')}>
                <span className="block text-sm font-medium">{key ? t(`roles.templates.${key}.name`) : t('roles.templates.blank')}</span>
                {key ? <span className="mt-1 block text-xs text-muted-foreground">{t(`roles.templates.${key}.description`)}</span> : null}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
