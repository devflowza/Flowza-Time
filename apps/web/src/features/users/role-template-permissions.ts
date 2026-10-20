import { ROLE_TEMPLATES, type Permission, type RoleTemplateKey } from '@flowza/contracts';

/**
 * The permissions a role template grants for this creator: the template's keys that the catalogue knows and that the creator
 * holds (nobody grants what they do not hold — the server and the database trigger refuse it anyway). `skipped` counts the others.
 */
export function templatePermissions(key: RoleTemplateKey, grantable: ReadonlySet<string>, known: ReadonlySet<string>): { permissions: Permission[]; skipped: number } {
  const all = ROLE_TEMPLATES[key].permissions;
  const permissions = all.filter((p) => grantable.has(p) && (known.size === 0 || known.has(p)));
  return { permissions, skipped: all.length - permissions.length };
}
