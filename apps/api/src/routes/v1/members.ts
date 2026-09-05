import type { Hono } from 'hono';
import { acceptInvitationSchema, inviteMemberSchema, memberListQuerySchema, updateMemberSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, noContent, ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as members from '../../services/members.service.js';

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
}
