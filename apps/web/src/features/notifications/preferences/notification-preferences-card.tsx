import { useTranslation } from 'react-i18next';
import { BellRing, Lock } from 'lucide-react';
import type { NotificationLocale, NotificationPreferenceCategoryDto } from '@flowza/contracts';
import { Card, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { registerNamespace } from '@/lib/i18n-namespace';
import { toast, toastError } from '@/lib/toast';
import { useActiveMembership } from '@/features/me/use-me';
import en from '@/locales/en/notification-preferences.json';
import ar from '@/locales/ar/notification-preferences.json';
import { useNotificationPreferences, useUpdateNotificationLocale, useUpdateNotificationPreferences } from './api';

registerNamespace('notificationPrefs', en, ar);

const CHANNELS = ['IN_APP', 'EMAIL'] as const;
const LOCALES: readonly NotificationLocale[] = ['en', 'ar'];

/**
 * The member's own notification preferences for the active organisation (HR portal Prompt 8): per category, in-app and
 * e-mail switches. Cells the member cannot switch (items they must act on, system and subscription notices) render locked
 * with the reason; categories that cannot reach the member are not listed. Each switch saves at once. Shown on
 * /account/notifications (every member — notifications review 8-P1-4), /my/profile (employees) and Settings → Notifications
 * (staff).
 */
export function NotificationPreferencesCard() {
  const { t } = useTranslation('notificationPrefs');
  const membership = useActiveMembership();
  const q = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const language = useUpdateNotificationLocale();
  // a platform support grant is not a membership: it keeps no preferences
  if (!membership || membership.roleKey.startsWith('platform_grant')) return null;

  const rows: NotificationPreferenceCategoryDto[] = q.data?.categories.filter((c) => c.relevant) ?? [];
  const hasLocked = rows.some((c) => c.channels.some((cell) => !cell.configurable || cell.alwaysOn.length > 0));
  const toggle = (category: NotificationPreferenceCategoryDto['category'], channel: (typeof CHANNELS)[number], enabled: boolean) =>
    update.mutate([{ category, channel, enabled }], { onSuccess: () => toast.success(t('saved')), onError: (e) => toastError(e) });

  return (
    <Card className="p-5" data-testid="notification-preferences">
      <div className="mb-4 flex items-start gap-3">
        <BellRing className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('description', { org: membership.organization.displayName })}</p>
        </div>
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data ? (
        <div className="space-y-2"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></div>
      ) : (
        <div className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.category')}</TableHead>
                {CHANNELS.map((ch) => <TableHead key={ch} className="w-24 text-center">{t(`channels.${ch}`)}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => {
                const label = t(`categories.${c.category}.label`);
                return (
                  <TableRow key={c.category}>
                    <TableCell>
                      <p className="font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{t(`categories.${c.category}.hint`)}</p>
                    </TableCell>
                    {CHANNELS.map((ch) => {
                      const cell = c.channels.find((x) => x.channel === ch);
                      if (!cell) return <TableCell key={ch} />;
                      const name = t('switchLabel', { category: label, channel: t(`channels.${ch}`) });
                      return (
                        <TableCell key={ch} className="text-center">
                          <span className="inline-flex items-center gap-1.5">
                            <Switch checked={cell.configurable ? cell.enabled : true} disabled={!cell.configurable || update.isPending} aria-label={name} onCheckedChange={(v) => toggle(c.category, ch, v)} />
                            {!cell.configurable ? <Lock className="size-3.5 text-muted-foreground" aria-label={t('lockedLabel')} /> : null}
                          </span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {hasLocked ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>{t('notes.actOn')}</li>
              <li>{t('notes.locked')}</li>
            </ul>
          ) : null}
          <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <label htmlFor="notification-language" className="text-sm font-medium">{t('language.label')}</label>
              <p className="text-xs text-muted-foreground">{t('language.hint')}</p>
            </div>
            <Select value={q.data.locale} onValueChange={(v) => language.mutate(v as NotificationLocale, { onSuccess: () => toast.success(t('saved')), onError: (e) => toastError(e) })} disabled={language.isPending}>
              <SelectTrigger id="notification-language" className="w-full sm:w-44" aria-label={t('language.label')}><SelectValue /></SelectTrigger>
              <SelectContent>{LOCALES.map((l) => <SelectItem key={l} value={l}>{t(`language.${l}`)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      )}
    </Card>
  );
}
