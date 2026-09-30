import { useQuery } from '@tanstack/react-query';
import type { MeDto, ModuleKey, Permission } from '@flowza/contracts';
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

/** The caller's own employee record in the active organisation (self-service portal), or null when not linked. */
export function useEmployeeId(): string | null {
  return useActiveMembership()?.employeeId ?? null;
}

export function useOrgTimezone(): string {
  return useActiveMembership()?.organization.timezone ?? 'Asia/Muscat';
}

export function useFeatureFlag(key: string): boolean {
  return useActiveMembership()?.featureFlags[key] ?? false;
}

/**
 * Whether a module (migration 20260929000600) is on for the active organisation: the plan, the platform's per-tenant switch,
 * the fleet-wide switch and a lapsed subscription decide, server-side. A key the cached /me does not carry reads as on —
 * the API's module gate is the authority; this only hides navigation.
 */
export function useModuleEnabled(key: ModuleKey): boolean {
  return useActiveMembership()?.modules?.[key] ?? true;
}

/** Every listed module is on (see useModuleEnabled). */
export function useModulesEnabled() {
  const m = useActiveMembership();
  return (...keys: ModuleKey[]) => keys.every((k) => m?.modules?.[k] ?? true);
}
