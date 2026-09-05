import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';

export interface NotificationDto { id: string; category: string; type: string; title: string; body: string | null; data: Record<string, unknown>; link: string | null; readAt: string | null; createdAt: string; organizationId: string | null }

export const notificationsKeys = { list: (page: number) => ['notifications', 'list', page] as const, unread: ['notifications', 'unread'] as const };

export function useNotifications(page = 1) {
  return useQuery({ queryKey: notificationsKeys.list(page), queryFn: () => api.get<PageEnvelope<NotificationDto>>('/me/notifications', { page, pageSize: 25 }) });
}
export function useUnreadCount(): number {
  const q = useQuery({ queryKey: notificationsKeys.unread, queryFn: async () => (await api.get<Envelope<{ unread: number }>>('/me/notifications/unread-count')).data.unread, refetchInterval: 60_000, retry: false });
  return q.data ?? 0;
}
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string | 'all') => (id === 'all' ? api.post('/me/notifications/read-all') : api.post(`/me/notifications/${id}/read`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
