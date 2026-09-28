import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationCategory, NotificationDeliveryChannel, NotificationLocale, NotificationPreferencesDto } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { meQueryKey, useActiveMembership } from '@/features/me/use-me';

export const notificationPreferencesKey = (orgId: string) => ['notification-preferences', orgId] as const;
export interface PreferenceChange { category: NotificationCategory; channel: NotificationDeliveryChannel; enabled: boolean }

/** The member's own (category × channel) matrix for the active organisation (GET /me/notification-preferences). */
export function useNotificationPreferences() {
  const orgId = useActiveMembership()?.organization.id ?? null;
  return useQuery({
    queryKey: notificationPreferencesKey(orgId ?? 'none'),
    queryFn: async () => (await api.get<Envelope<NotificationPreferencesDto>>('/me/notification-preferences', { organizationId: orgId })).data,
    enabled: orgId !== null,
  });
}

/** Stores cells (PUT /me/notification-preferences?organizationId=…): the switch moves at once and rolls back on a refusal. */
export function useUpdateNotificationPreferences() {
  const qc = useQueryClient();
  const orgId = useActiveMembership()?.organization.id ?? null;
  const key = notificationPreferencesKey(orgId ?? 'none');
  return useMutation({
    mutationFn: async (preferences: PreferenceChange[]) => {
      if (!orgId) throw new Error('No active organisation');
      return (await api.put<Envelope<NotificationPreferencesDto>>(`/me/notification-preferences?organizationId=${encodeURIComponent(orgId)}`, { preferences })).data;
    },
    onMutate: async (preferences) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<NotificationPreferencesDto>(key);
      if (previous) {
        qc.setQueryData<NotificationPreferencesDto>(key, {
          ...previous,
          categories: previous.categories.map((c) => ({ ...c, channels: c.channels.map((cell) => ({ ...cell, enabled: preferences.find((p) => p.category === c.category && p.channel === cell.channel)?.enabled ?? cell.enabled })) })),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => { if (context?.previous) qc.setQueryData(key, context.previous); },
    onSuccess: (data) => { qc.setQueryData(key, data); },
  });
}

/** The language notifications and e-mails are written in is the member's profile locale (PATCH /me). */
export function useUpdateNotificationLocale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (locale: NotificationLocale) => api.patch('/me', { locale }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: meQueryKey }); void qc.invalidateQueries({ queryKey: ['notification-preferences'] }); },
  });
}
