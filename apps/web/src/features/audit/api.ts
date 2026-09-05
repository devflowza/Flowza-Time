import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AuditLogDto } from '@flowza/contracts';
import { api, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useOrgId } from '@/features/me/use-me';

export type AuditQuery = Record<string, string | number | undefined>;

export function useAuditLogs(query: AuditQuery) {
  const orgId = useOrgId();
  return useQuery({ queryKey: qk.list(orgId, 'audit', query), queryFn: () => api.get<PageEnvelope<AuditLogDto>>(`/orgs/${orgId}/audit`, query), placeholderData: keepPreviousData });
}

/** Entity types written by the API modules (see docs/api.md audit actions). Free-text `action` covers the rest. */
export const AUDIT_ENTITY_TYPES = ['organization', 'member', 'invitation', 'role', 'branch', 'department', 'designation', 'team', 'employee', 'employee_document', 'import_job', 'device', 'device_group', 'sync_job', 'attendance_record', 'correction', 'shift', 'holiday', 'leave', 'report', 'platform'] as const;
