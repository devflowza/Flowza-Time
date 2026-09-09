import { useQuery } from '@tanstack/react-query';
import type { MeDto, Permission } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { useUiStore } from '@/stores/ui-store';
import { readCachedMe, writeCachedMe } from './me-cache';

export const meQueryKey = ['me'] as const;

export function useMe() {
  // The cached copy is handed to the query as initial data stamped with its age, so the shell renders at once and the
  // query still refetches on mount whenever the copy is older than staleTime.
  const cached = readCachedMe();
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async () => { const data = (await api.get<Envelope<MeDto>>('/me')).data; writeCachedMe(data); return data; },
    staleTime: 60_000,
    ...(cached ? { initialData: cached.data, initialDataUpdatedAt: cached.at } : {}),
  });
}

export type ActiveMembership = MeDto['memberships'][number];

/** Active organisation membership (persisted choice, else first). */
export function useActiveMembership(): ActiveMembership | null {
  const { data } = useMe();
  const activeOrgId = useUiStore((s) => s.activeOrgId);
  if (!data || data.memberships.length === 0) return null;
  return data.memberships.find((m) => m.organization.id === activeOrgId) ?? data.memberships[0] ?? null;
}

/** UI gating helper — the server always re-checks permissions. */
export function useCan() {
  const m = useActiveMembership();
  return (...perms: Permission[]) => !!m && perms.every((p) => m.permissions.includes(p));
}

export function useOrgId(): string {
  const m = useActiveMembership();
  if (!m) throw new Error('No active organisation');
  return m.organization.id;
}

export function useOrgTimezone(): string {
  return useActiveMembership()?.organization.timezone ?? 'Asia/Muscat';
}

export function useFeatureFlag(key: string): boolean {
  return useActiveMembership()?.featureFlags[key] ?? false;
}
