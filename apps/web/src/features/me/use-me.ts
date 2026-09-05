import { useQuery } from '@tanstack/react-query';
import type { MeDto, Permission } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { useUiStore } from '@/stores/ui-store';

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: async () => (await api.get<Envelope<MeDto>>('/me')).data, staleTime: 60_000 });
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
