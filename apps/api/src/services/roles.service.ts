import { isPermission, type Permission, type PermissionDto, type RoleDto, type RoleInput, type UpdateRoleInput } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requireMembership, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, audit } from '../lib/service.js';
import { toCount } from '../lib/pagination.js';
import { groupBy, isoDateTime } from '../lib/mappers.js';

const ROLE_COLUMNS = ['id', 'organizationId', 'key', 'name', 'description', 'isSystem', 'createdAt', 'updatedAt'] as const;
type RoleRow = { id: string; organizationId: string | null; key: string; name: string; description: string | null; isSystem: boolean; createdAt: Date; updatedAt: Date };

function toRoleDto(row: RoleRow, permissions: string[], memberCount?: number): RoleDto {
  return { id: row.id, organizationId: row.organizationId, key: row.key, name: row.name, description: row.description, isSystem: row.isSystem, permissions: permissions.sort(), memberCount, createdAt: isoDateTime(row.createdAt), updatedAt: isoDateTime(row.updatedAt) };
}

export async function listPermissions(deps: ApiDeps, actor: Actor): Promise<PermissionDto[]> {
  return runUser(deps.db, actor, async (trx) => {
    const rows = await trx.selectFrom('permissions').select(['key', 'category', 'description', 'sortOrder']).orderBy('sortOrder').execute();
    return rows.filter((r) => isPermission(r.key)).map((r) => ({ key: r.key as Permission, category: r.category, description: r.description, sortOrder: r.sortOrder }));
  });
}

async function rolesWithPermissions(trx: Trx, orgId: string, roleIds?: string[]): Promise<RoleDto[]> {
  let q = trx.selectFrom('roles').select(ROLE_COLUMNS).where((eb) => eb.or([eb('isSystem', '=', true), eb('organizationId', '=', orgId)]));
  if (roleIds) q = q.where('id', 'in', roleIds.length ? roleIds : ['00000000-0000-0000-0000-000000000000']);
  const roles = await q.orderBy('isSystem', 'desc').orderBy('name').execute();
  if (roles.length === 0) return [];
  const ids = roles.map((r) => r.id);
  const perms = groupBy(await trx.selectFrom('rolePermissions').select(['roleId', 'permissionKey']).where('roleId', 'in', ids).execute(), (p) => p.roleId);
  const counts = new Map((await trx.selectFrom('orgMemberships').select(['roleId', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('roleId', 'in', ids).groupBy('roleId').execute()).map((r) => [r.roleId, toCount(r.n)]));
  return roles.map((r) => toRoleDto(r, (perms.get(r.id) ?? []).map((p) => p.permissionKey), counts.get(r.id) ?? 0));
}

export async function listRoles(deps: ApiDeps, actor: Actor, orgId: string): Promise<RoleDto[]> {
  requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, (trx) => rolesWithPermissions(trx, orgId));
}

function assertGrantable(actorPermissions: readonly string[], requested: readonly string[]): void {
  const missing = requested.filter((p) => !actorPermissions.includes(p));
  if (missing.length) throw errors.forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}.`);
}

export async function createRole(deps: ApiDeps, actor: Actor, orgId: string, input: RoleInput): Promise<RoleDto> {
  const grant = requirePermission(actor.principal, orgId, 'role.manage');
  assertGrantable(grant.permissions, input.permissions);
  return runUser(deps.db, actor, async (trx) => {
    const clash = await trx.selectFrom('roles').select('id').where('key', '=', input.key).where((eb) => eb.or([eb('isSystem', '=', true), eb('organizationId', '=', orgId)])).executeTakeFirst();
    if (clash) throw errors.conflict('A role with this key already exists.');
    const role = await trx.insertInto('roles').values({ organizationId: orgId, key: input.key, name: input.name, description: input.description ?? null, isSystem: false }).returning(ROLE_COLUMNS).executeTakeFirstOrThrow();
    const perms = [...new Set(input.permissions)];
    await trx.insertInto('rolePermissions').values(perms.map((p) => ({ roleId: role.id, permissionKey: p }))).execute();
    await audit(trx, actor, orgId, 'role.created', 'role', { entityId: role.id, newValue: { key: input.key, name: input.name, permissions: perms } });
    return toRoleDto(role, perms, 0);
  });
}

export async function updateRole(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateRoleInput): Promise<RoleDto> {
  const grant = requirePermission(actor.principal, orgId, 'role.manage');
  if (input.permissions) assertGrantable(grant.permissions, input.permissions);
  return runUser(deps.db, actor, async (trx) => {
    const before = (await rolesWithPermissions(trx, orgId, [id]))[0];
    if (!before) throw errors.notFound('Role', id);
    if (before.isSystem) throw errors.invalidState('System roles cannot be edited. Create a custom role instead.');
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.description !== undefined) patch['description'] = input.description;
    if (Object.keys(patch).length) await trx.updateTable('roles').set(patch).where('id', '=', id).where('organizationId', '=', orgId).execute();
    if (input.permissions) {
      const perms = [...new Set(input.permissions)];
      await trx.deleteFrom('rolePermissions').where('roleId', '=', id).execute();
      await trx.insertInto('rolePermissions').values(perms.map((p) => ({ roleId: id, permissionKey: p }))).execute();
    }
    const after = (await rolesWithPermissions(trx, orgId, [id]))[0]!;
    await audit(trx, actor, orgId, 'role.updated', 'role', { entityId: id, oldValue: { name: before.name, description: before.description, permissions: before.permissions }, newValue: { name: after.name, description: after.description, permissions: after.permissions } });
    return after;
  });
}

export async function deleteRole(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'role.manage');
  return runUser(deps.db, actor, async (trx) => {
    const role = (await rolesWithPermissions(trx, orgId, [id]))[0];
    if (!role) throw errors.notFound('Role', id);
    if (role.isSystem) throw errors.invalidState('System roles cannot be deleted.');
    const inUse = toCount((await trx.selectFrom('orgMemberships').select((eb) => eb.fn.countAll().as('n')).where('roleId', '=', id).executeTakeFirst())?.n)
      + toCount((await trx.selectFrom('invitations').select((eb) => eb.fn.countAll().as('n')).where('roleId', '=', id).where('acceptedAt', 'is', null).executeTakeFirst())?.n);
    if (inUse > 0) throw errors.conflict('The role is assigned to members or pending invitations and cannot be deleted.', { inUse });
    await trx.deleteFrom('roles').where('id', '=', id).where('organizationId', '=', orgId).execute();
    await audit(trx, actor, orgId, 'role.deleted', 'role', { entityId: id, oldValue: { key: role.key, name: role.name, permissions: role.permissions } });
  });
}
