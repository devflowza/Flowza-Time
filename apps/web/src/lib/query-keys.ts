/** Central query-key factory so mutations can invalidate precisely. Feature modules extend it under their own key. */
export const qk = {
  me: ['me'] as const,
  org: (orgId: string) => ['org', orgId] as const,
  list: (orgId: string, entity: string, params?: unknown) => ['org', orgId, entity, 'list', params ?? {}] as const,
  detail: (orgId: string, entity: string, id: string) => ['org', orgId, entity, 'detail', id] as const,
  entity: (orgId: string, entity: string) => ['org', orgId, entity] as const,
};
