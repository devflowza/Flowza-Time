import type { Hono } from 'hono';
import { acceptInvitationSchema, inviteMemberSchema, memberListQuerySchema, portalAccessChangeSchema, portalAccessInviteSchema, updateMemberSchema, validateInvitationSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, noContent, ok, paginated } from '../../lib/http.js';
import { body, optionalBody, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as members from '../../services/members.service.js';
import * as access from '../../services/portal-access.service.js';

export function registerMemberRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/members', async (c) => {
    const q = query(c, memberListQuerySchema);
    const { data, total } = await members.listMembers(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });
  v1.get('/orgs/:orgId/members/:id', async (c) => ok(c, await members.getMember(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/members/:id', async (c) => ok(c, await members.updateMember(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateMemberSchema))));
  v1.delete('/orgs/:orgId/members/:id', async (c) => ok(c, await members.suspendMember(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/invitations', async (c) => ok(c, await members.listInvitations(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/invitations', async (c) => created(c, await members.inviteMember(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, inviteMemberSchema))));
  v1.delete('/orgs/:orgId/invitations/:id', async (c) => { await members.revokeInvitation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  v1.post('/invitations/accept', async (c) => ok(c, await members.acceptInvitation(deps, actorOf(c, deps), (await body(c, acceptInvitationSchema)).token)));
  // invitations parity (HR portal Prompt 6b): resend, and FlowZa Time access on an employee profile
  v1.post('/orgs/:orgId/invitations/:id/resend', async (c) => created(c, await members.resendInvitation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/employees/:id/portal-access', async (c) => ok(c, await access.getPortalAccess(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/employees/:id/portal-access/invite', async (c) => created(c, await access.invitePortalAccess(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await optionalBody(c, portalAccessInviteSchema))));
  v1.post('/orgs/:orgId/employees/:id/portal-access/revoke', async (c) => ok(c, await access.revokePortalAccess(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await optionalBody(c, portalAccessChangeSchema))));
  v1.post('/orgs/:orgId/employees/:id/portal-access/restore', async (c) => ok(c, await access.restorePortalAccess(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await optionalBody(c, portalAccessChangeSchema))));
  v1.post('/orgs/:orgId/employees/:id/portal-access/resend', async (c) => ok(c, await access.resendPortalAccess(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}

/** Public invitation routes (no session): the preview before sign-in (B-70). Mounted by app.ts with its own IP limiter. */
export function registerPublicInvitationRoutes(pub: Hono<AppEnv>, deps: ApiDeps): void {
  pub.post('/invitations/validate', async (c) => ok(c, await members.validateInvitation(deps, c.get('requestId'), (await body(c, validateInvitationSchema)).token)));
}
