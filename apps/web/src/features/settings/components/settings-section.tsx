import { useTranslation } from 'react-i18next';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Skeleton, Switch } from '@/components/ui';

/** Card + sticky footer used by every settings form. */
export function SettingsSection({ title, description, children, onSubmit, saving, dirty, readOnly, footer }: { title: string; description?: string; children: React.ReactNode; onSubmit?: (e: React.FormEvent) => void; saving?: boolean; dirty?: boolean; readOnly?: boolean; footer?: React.ReactNode }) {
  const { t } = useTranslation();
  const body = (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
      {onSubmit && !readOnly ? <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}<Button type="submit" loading={saving} disabled={dirty === false}>{t('common.save')}</Button></div> : null}
    </Card>
  );
  return onSubmit ? <form onSubmit={onSubmit} noValidate>{body}</form> : body;
}
export function SectionSkeleton() { return <Card><CardContent className="space-y-3 pt-5"><Skeleton className="h-6 w-48" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></CardContent></Card>; }
export function SectionError({ error, onRetry }: { error: unknown; onRetry: () => void }) { return <ErrorState error={error} onRetry={onRetry} />; }

export function SwitchRow({ id, label, hint, checked, onCheckedChange, disabled, control }: { id: string; label: string; hint?: string; checked?: boolean; onCheckedChange?: (v: boolean) => void; disabled?: boolean; control?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0"><label htmlFor={id} className="text-sm font-medium">{label}</label>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>
      {control ?? <Switch id={id} checked={!!checked} onCheckedChange={onCheckedChange} disabled={disabled} />}
    </div>
  );
}
