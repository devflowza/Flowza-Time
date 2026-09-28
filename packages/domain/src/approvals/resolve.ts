import type { ApprovalStepSpec, ApproverCandidate, ChainRung, ResolutionContext, ResolutionPath, ResolvedActor, StepResolution } from './types.js';

interface Partial { actors: ResolvedActor[]; path: ResolutionPath; reason: string | null }

/** Seat of an actor row: a delegate sits in the seat of the approver they act for. */
export const seatOf = (a: { userId: string; viaDelegationOf: string | null }): string => a.viaDelegationOf ?? a.userId;

/**
 * One row per PERSON per level (the database keys actors on (step, user)): a person already seated — in their own seat or
 * as somebody's delegate — is never added twice. An HR admin who is also a colleague's delegate keeps their own seat.
 */
function push(out: ResolvedActor[], actor: ResolvedActor): void {
  if (!out.some((a) => a.userId === actor.userId)) out.push(actor);
}

/**
 * Turn a set of principals into actor rows: each active principal, plus their delegate (stamped `viaDelegationOf`) when
 * an active delegation exists — Finance parity: the delegate acts alongside the approver, in the approver's seat. Own seats
 * are placed first, so a person who is both an approver and another approver's delegate sits in their own seat.
 */
function expand(userIds: readonly string[], ctx: ResolutionContext): ResolvedActor[] {
  const out: ResolvedActor[] = [];
  const active = userIds.filter((u) => ctx.activeUserIds.has(u));
  for (const userId of active) push(out, { userId, viaDelegationOf: null });
  for (const userId of active) {
    const delegate = ctx.delegateOf(userId);
    if (delegate && delegate !== userId && ctx.activeUserIds.has(delegate)) push(out, { userId: delegate, viaDelegationOf: userId });
  }
  return out;
}

/**
 * One person of the reporting line as a seat. Absent (no linked login, no active membership, approved leave today) means the
 * seat is unusable UNLESS an active delegation substitutes the delegate — who then acts in the absent approver's seat.
 * A linked login whose membership is not active is reported as such ("membership suspended"), never as "no linked login".
 */
function candidate(c: ApproverCandidate | null, ctx: ResolutionContext): { actors: ResolvedActor[]; reason: string | null } {
  if (!c) return { actors: [], reason: 'not set' };
  if (!c.userId) return { actors: [], reason: c.absentReason ?? 'no linked login' };
  if (!ctx.activeUserIds.has(c.userId)) return { actors: [], reason: c.absentReason ?? 'no active membership' };
  const delegate = ctx.delegateOf(c.userId);
  const delegateActor: ResolvedActor | null = delegate && delegate !== c.userId && ctx.activeUserIds.has(delegate) ? { userId: delegate, viaDelegationOf: c.userId } : null;
  if (c.absent) {
    if (delegateActor) return { actors: [delegateActor], reason: `${c.absentReason ?? 'absent'}; delegated` };
    return { actors: [], reason: c.absentReason ?? 'absent' };
  }
  return { actors: delegateActor ? [{ userId: c.userId, viaDelegationOf: null }, delegateActor] : [{ userId: c.userId, viaDelegationOf: null }], reason: delegateActor ? 'delegation active' : null };
}

function rungSeat(rung: ChainRung | undefined, ctx: ResolutionContext): { actors: ResolvedActor[]; which: 'primary' | 'secondary' | null; reason: string | null } {
  if (!rung) return { actors: [], which: null, reason: 'chain ends' };
  const p = candidate(rung.primary, ctx);
  if (p.actors.length) return { actors: p.actors, which: 'primary', reason: p.reason };
  const s = candidate(rung.secondary, ctx);
  if (s.actors.length) return { actors: s.actors, which: 'secondary', reason: `primary manager: ${p.reason ?? 'unavailable'}; secondary manager used` };
  return { actors: [], which: null, reason: `primary manager: ${p.reason ?? 'unavailable'}; secondary manager: ${s.reason ?? 'unavailable'}` };
}

function base(step: ApprovalStepSpec, ctx: ResolutionContext): Partial {
  switch (step.approverType) {
    case 'MANAGER': {
      const r = rungSeat(ctx.chain[0], ctx);
      return { actors: r.actors, path: r.which ?? 'unresolved', reason: r.reason };
    }
    case 'SECONDARY_MANAGER': {
      const s = candidate(ctx.chain[0]?.secondary ?? null, ctx);
      return { actors: s.actors, path: s.actors.length ? 'secondary' : 'unresolved', reason: s.reason };
    }
    case 'MANAGER_CHAIN': {
      const level = Math.max(1, Math.min(10, Math.floor(step.chainLevel ?? 1)));
      let top: { actors: ResolvedActor[]; k: number } | null = null;
      for (let k = 0; k < level; k += 1) {
        const r = rungSeat(ctx.chain[k], ctx);
        if (r.actors.length === 0) break; // the chain is shorter than the level (or a rung is unreachable): keep the most senior found
        top = { actors: r.actors, k };
      }
      if (!top) return { actors: [], path: 'unresolved', reason: 'no usable manager in the reporting line' };
      if (top.k === level - 1) return { actors: top.actors, path: level === 1 ? 'primary' : `chain_step_${level}`, reason: null };
      return { actors: top.actors, path: 'chain_top', reason: `reporting line has ${top.k + 1} usable level(s), ${level} requested` };
    }
    case 'HR_ADMIN': return { actors: expand(ctx.hrAdminUserIds, ctx), path: 'hr_admin', reason: null };
    case 'DEPARTMENT_HEAD': {
      const d = candidate(ctx.departmentHead, ctx);
      return { actors: d.actors, path: d.actors.length ? 'department_head' : 'unresolved', reason: d.reason };
    }
    case 'BRANCH_MANAGER': return { actors: expand(ctx.branchManagerUserIds, ctx), path: 'branch_manager', reason: ctx.branchManagerUserIds.length ? null : 'no branch manager for the subject branch' };
    case 'ROLE': {
      if (step.permission) return { actors: expand(ctx.permissionHolderUserIds(step.permission), ctx), path: 'permission', reason: null };
      if (step.roleId) return { actors: expand(ctx.roleMemberUserIds(step.roleId), ctx), path: 'role', reason: null };
      return { actors: [], path: 'unresolved', reason: 'ROLE step without a role or a permission' };
    }
    case 'USER': {
      if (step.userId && ctx.activeUserIds.has(step.userId)) return { actors: expand([step.userId], ctx), path: 'user', reason: null };
      return { actors: [], path: 'unresolved', reason: 'named user is not an active member' };
    }
    default: {
      const exhaustive: never = step.approverType;
      return { actors: [], path: 'unresolved', reason: `unknown approver type ${String(exhaustive)}` };
    }
  }
}

/**
 * Segregation of duties (Finance B-87): the subject's login never decides their own request, whatever seat resolved to
 * them (a delegate acting for the subject is dropped too). The requester is dropped at every rung of the ladder — the
 * level itself, the HR admins, the owners — and is kept only as the LAST resort: nobody else at all remains AND the request
 * has a subject (HR filed it for somebody and is the organisation's only possible approver). There is no switch that lifts
 * these rules.
 *
 * The one exception is the organisation's OWNER (the only role the engine lets decide about themselves, and only with a
 * logged `sod_owner_bypass`): at the owner rung, when the subject is an owner and nobody else at all can hold the seat —
 * a single-owner organisation with no HR admin — the subject-owner is seated in their own seat (never their delegate), so
 * their own leave or correction can still be decided instead of being refused outright.
 */
function segregate(actors: readonly ResolvedActor[], ctx: ResolutionContext, opts: { lastResort?: boolean } = {}): { actors: ResolvedActor[]; reason: string | null } {
  const notes: string[] = [];
  let out = actors.filter((a) => !(ctx.subjectUserId && (a.userId === ctx.subjectUserId || a.viaDelegationOf === ctx.subjectUserId)));
  if (out.length !== actors.length) notes.push('subject excluded');
  if (ctx.requestedBy) {
    const withoutRequestor = out.filter((a) => a.userId !== ctx.requestedBy && a.viaDelegationOf !== ctx.requestedBy);
    if (withoutRequestor.length !== out.length) {
      if (withoutRequestor.length > 0 || !opts.lastResort || ctx.subjectEmployeeId === null) { out = withoutRequestor; notes.push('requester excluded'); }
      else notes.push('requester kept: only resolvable approver');
    }
  }
  if (out.length === 0 && opts.lastResort && ctx.subjectUserId && ctx.ownerUserIds.includes(ctx.subjectUserId)) {
    const self = actors.find((a) => a.userId === ctx.subjectUserId && a.viaDelegationOf === null);
    if (self) { out = [self]; notes.push('subject kept: the organisation\'s only possible approver is this owner (owner bypass, logged when they decide)'); }
  }
  return { actors: out, reason: notes.length ? notes.join('; ') : null };
}

const joinReasons = (...parts: Array<string | null | undefined>): string | null => { const p = parts.filter((x): x is string => !!x); return p.length ? p.join('; ') : null; };

function finish(actors: ResolvedActor[], path: ResolutionPath, reason: string | null, step: ApprovalStepSpec): StepResolution {
  const seatCount = new Set(actors.map(seatOf)).size;
  const requiredCount = step.mode === 'ALL' ? null : step.mode === 'QUORUM' ? Math.max(1, Math.floor(step.requiredCount ?? 1)) : 1;
  return { actors, path, reason, seatCount, requiredCount, unresolved: actors.length === 0 };
}

/**
 * Resolve one workflow level to the people who may decide it (see the ladders in @flowza/contracts). The ladder always
 * ends in the HR admins and then the owner, so a request is never stranded because a manager left; only an organisation
 * with nobody in the owner role produces `unresolved` (the caller refuses the submission — Finance B-85).
 */
export function resolveStepActors(step: ApprovalStepSpec, ctx: ResolutionContext): StepResolution {
  const b = base(step, ctx);
  const first = segregate(b.actors, ctx);
  if (first.actors.length > 0) return finish(first.actors, b.path, joinReasons(b.reason, first.reason), step);
  const why = joinReasons(b.reason, first.reason, b.actors.length > 0 && first.actors.length === 0 ? 'segregation of duties left nobody' : null);
  if (step.approverType !== 'HR_ADMIN') {
    const hr = segregate(expand(ctx.hrAdminUserIds, ctx), ctx);
    if (hr.actors.length > 0) return finish(hr.actors, 'hr_admin', joinReasons(why, 'fell back to HR admins', hr.reason), step);
  }
  const owners = segregate(expand(ctx.ownerUserIds, ctx), ctx, { lastResort: true });
  if (owners.actors.length > 0) return finish(owners.actors, 'owner', joinReasons(why, 'fell back to the owner', owners.reason), step);
  return { actors: [], path: 'unresolved', reason: joinReasons(why, 'no HR admin or owner available'), seatCount: 0, requiredCount: null, unresolved: true };
}
