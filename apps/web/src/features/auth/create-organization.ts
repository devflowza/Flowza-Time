import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateOwnOrganizationInput, CreateOwnOrganizationResult } from '@flowza/contracts';
import { api, type Envelope } from '@/lib/api-client';
import { meQueryKey } from '@/features/me/use-me';

/**
 * Self-service organisation creation (`POST /orgs`), shared by the sign-up page and the shell.
 *
 * Sign-up can only finish the job when Supabase hands back a session straight away. A project that requires email
 * confirmation does not, so the company details are parked in localStorage and picked up by the shell's
 * create-organisation screen the first time the confirmed user signs in with no membership.
 */
export const PENDING_ORGANIZATION_KEY = 'flowza.pendingOrganization';
export type PendingOrganization = Pick<CreateOwnOrganizationInput, 'displayName' | 'timezone'>;

const pendingSchema = z.object({ displayName: z.string().min(1), timezone: z.string().min(1) });

export function savePendingOrganization(input: PendingOrganization): void {
  try { window.localStorage.setItem(PENDING_ORGANIZATION_KEY, JSON.stringify(input)); } catch { /* storage unavailable: the user simply types the name again */ }
}
export function readPendingOrganization(): PendingOrganization | null {
  try {
    const raw = window.localStorage.getItem(PENDING_ORGANIZATION_KEY);
    if (!raw) return null;
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function clearPendingOrganization(): void {
  try { window.localStorage.removeItem(PENDING_ORGANIZATION_KEY); } catch { /* nothing to clear */ }
}

/** The browser's zone is the best first guess for a company we know nothing else about; Settings can change it. */
export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Muscat'; } catch { return 'Asia/Muscat'; }
}

export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PendingOrganization) => (await api.post<Envelope<CreateOwnOrganizationResult>>('/orgs', input, { idempotencyKey: crypto.randomUUID() })).data,
    onSuccess: async () => { clearPendingOrganization(); await qc.invalidateQueries({ queryKey: meQueryKey }); },
  });
}
