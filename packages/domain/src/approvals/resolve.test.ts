import { describe, expect, it } from 'vitest';
import { resolveStepActors, seatOf } from './resolve.js';
import type { ApprovalStepSpec, ApproverCandidate, ResolutionContext } from './types.js';

const U = { subject: 'u-subject', requester: 'u-hr', manager: 'u-manager', secondary: 'u-secondary', grand: 'u-grand', great: 'u-great', hr1: 'u-hr1', hr2: 'u-hr2', owner: 'u-owner', head: 'u-head', bm: 'u-bm', delegate: 'u-delegate', named: 'u-named', gone: 'u-gone' };
const cand = (userId: string | null, employeeId = `e-${userId ?? 'none'}`, absent = false, absentReason: string | null = null): ApproverCandidate => ({ employeeId, userId, absent, absentReason });

function ctx(over: Partial<ResolutionContext> = {}): ResolutionContext {
  const active = new Set(Object.values(U).filter((u) => u !== U.gone));
  return {
    subjectEmployeeId: 'e-subject', subjectUserId: U.subject, requestedBy: U.subject,
    chain: [{ primary: cand(U.manager), secondary: cand(U.secondary) }, { primary: cand(U.grand), secondary: null }, { primary: cand(U.great), secondary: null }],
    departmentHead: cand(U.head), branchManagerUserIds: [U.bm], hrAdminUserIds: [U.hr1, U.hr2], ownerUserIds: [U.owner],
    activeUserIds: active,
    roleMemberUserIds: (roleId) => (roleId === 'role-hr' ? [U.hr1, U.hr2] : []),
    permissionHolderUserIds: (p) => (p === 'leave.approve' ? [U.manager, U.hr1, U.owner, U.subject] : []),
    delegateOf: () => null,
    ...over,
  };
}
const step = (over: Partial<ApprovalStepSpec> = {}): ApprovalStepSpec => ({ order: 1, approverType: 'MANAGER', mode: 'ANY', ...over });
const users = (r: ReturnType<typeof resolveStepActors>) => r.actors.map((a) => a.userId).sort();

describe('resolveStepActors — MANAGER ladder', () => {
  it('resolves to the primary manager', () => {
    const r = resolveStepActors(step(), ctx());
    expect(users(r)).toEqual([U.manager]);
    expect(r.path).toBe('primary');
    expect(r.seatCount).toBe(1);
    expect(r.requiredCount).toBe(1);
  });
  it('falls back to the secondary manager when the primary has no linked login, no active membership or is on leave', () => {
    expect(resolveStepActors(step(), ctx({ chain: [{ primary: cand(null), secondary: cand(U.secondary) }] })).path).toBe('secondary');
    expect(resolveStepActors(step(), ctx({ chain: [{ primary: cand(U.gone), secondary: cand(U.secondary) }] })).path).toBe('secondary');
    const leave = resolveStepActors(step(), ctx({ chain: [{ primary: cand(U.manager, 'e-m', true, 'on approved leave'), secondary: cand(U.secondary) }] }));
    expect(users(leave)).toEqual([U.secondary]);
    expect(leave.reason).toMatch(/on approved leave/);
  });
  it('substitutes the delegate of an absent manager and records who they act for', () => {
    const r = resolveStepActors(step(), ctx({ chain: [{ primary: cand(U.manager, 'e-m', true, 'on approved leave'), secondary: cand(U.secondary) }], delegateOf: (u) => (u === U.manager ? U.delegate : null) }));
    expect(r.actors).toEqual([{ userId: U.delegate, viaDelegationOf: U.manager }]);
    expect(r.path).toBe('primary');
    expect(seatOf(r.actors[0]!)).toBe(U.manager);
  });
  it('stamps the delegate of a present manager alongside them, in the same seat', () => {
    const r = resolveStepActors(step(), ctx({ delegateOf: (u) => (u === U.manager ? U.delegate : null) }));
    expect(r.actors).toEqual([{ userId: U.manager, viaDelegationOf: null }, { userId: U.delegate, viaDelegationOf: U.manager }]);
    expect(r.seatCount).toBe(1);
  });
  it('goes to the HR admins, then the owner, when nobody in the line is usable', () => {
    const noLine = ctx({ chain: [{ primary: cand(null), secondary: null }] });
    const hr = resolveStepActors(step(), noLine);
    expect(users(hr)).toEqual([U.hr1, U.hr2]);
    expect(hr.path).toBe('hr_admin');
    const owner = resolveStepActors(step(), { ...noLine, hrAdminUserIds: [] });
    expect(users(owner)).toEqual([U.owner]);
    expect(owner.path).toBe('owner');
    const nobody = resolveStepActors(step(), { ...noLine, hrAdminUserIds: [], ownerUserIds: [] });
    expect(nobody.unresolved).toBe(true);
    expect(nobody.actors).toEqual([]);
  });
});

describe('resolveStepActors — MANAGER_CHAIN', () => {
  it('walks N rungs of primary managers', () => {
    expect(resolveStepActors(step({ approverType: 'MANAGER_CHAIN', chainLevel: 2 }), ctx())).toMatchObject({ path: 'chain_step_2' });
    expect(users(resolveStepActors(step({ approverType: 'MANAGER_CHAIN', chainLevel: 2 }), ctx()))).toEqual([U.grand]);
    expect(users(resolveStepActors(step({ approverType: 'MANAGER_CHAIN', chainLevel: 3 }), ctx()))).toEqual([U.great]);
    expect(resolveStepActors(step({ approverType: 'MANAGER_CHAIN', chainLevel: 1 }), ctx()).path).toBe('primary');
  });
  it('substitutes an absent rung with that rung\'s secondary manager', () => {
    const c = ctx({ chain: [{ primary: cand(U.manager), secondary: cand(U.secondary) }, { primary: cand(U.grand, 'e-g', true, 'on approved leave'), secondary: cand(U.great) }] });
    const r = resolveStepActors(step({ approverType: 'MANAGER_CHAIN', chainLevel: 2 }), c);
    expect(users(r)).toEqual([U.great]);
    expect(r.path).toBe('chain_step_2');
  });
  it('resolves a chain shorter than the level to the most senior reachable manager (chain_top)', () => {
    const r = resolveStepActors(step({ approverType: 'MANAGER_CHAIN', chainLevel: 5 }), ctx());
    expect(users(r)).toEqual([U.great]);
    expect(r.path).toBe('chain_top');
    expect(r.reason).toMatch(/3 usable level/);
  });
  it('falls back to HR admins when the line is empty', () => {
    expect(resolveStepActors(step({ approverType: 'MANAGER_CHAIN', chainLevel: 2 }), ctx({ chain: [] })).path).toBe('hr_admin');
  });
});

describe('resolveStepActors — other approver types', () => {
  it('SECONDARY_MANAGER, DEPARTMENT_HEAD, BRANCH_MANAGER, HR_ADMIN', () => {
    expect(users(resolveStepActors(step({ approverType: 'SECONDARY_MANAGER' }), ctx()))).toEqual([U.secondary]);
    expect(resolveStepActors(step({ approverType: 'SECONDARY_MANAGER' }), ctx({ chain: [{ primary: cand(U.manager), secondary: null }] })).path).toBe('hr_admin');
    expect(resolveStepActors(step({ approverType: 'DEPARTMENT_HEAD' }), ctx())).toMatchObject({ path: 'department_head' });
    expect(resolveStepActors(step({ approverType: 'DEPARTMENT_HEAD' }), ctx({ departmentHead: null })).path).toBe('hr_admin');
    expect(users(resolveStepActors(step({ approverType: 'BRANCH_MANAGER' }), ctx()))).toEqual([U.bm]);
    expect(resolveStepActors(step({ approverType: 'BRANCH_MANAGER' }), ctx({ branchManagerUserIds: [] })).path).toBe('hr_admin');
    expect(users(resolveStepActors(step({ approverType: 'HR_ADMIN' }), ctx()))).toEqual([U.hr1, U.hr2]);
    expect(resolveStepActors(step({ approverType: 'HR_ADMIN' }), ctx({ hrAdminUserIds: [] })).path).toBe('owner');
  });
  it('ROLE by permission (holders in the org) or by role id; USER by id — inactive named users fall back', () => {
    const byPerm = resolveStepActors(step({ approverType: 'ROLE', permission: 'leave.approve' }), ctx());
    expect(users(byPerm)).toEqual([U.hr1, U.manager, U.owner]); // the subject holds the permission but is excluded
    expect(byPerm.path).toBe('permission');
    const byRole = resolveStepActors(step({ approverType: 'ROLE', roleId: 'role-hr' }), ctx());
    expect(users(byRole)).toEqual([U.hr1, U.hr2]);
    expect(byRole.path).toBe('role');
    expect(resolveStepActors(step({ approverType: 'ROLE', roleId: 'role-empty' }), ctx()).path).toBe('hr_admin');
    expect(resolveStepActors(step({ approverType: 'USER', userId: U.named }), ctx())).toMatchObject({ path: 'user', actors: [{ userId: U.named, viaDelegationOf: null }] });
    const gone = resolveStepActors(step({ approverType: 'USER', userId: U.gone }), ctx());
    expect(gone.path).toBe('hr_admin');
    expect(gone.reason).toMatch(/not an active member/);
  });
});

describe('resolveStepActors — segregation of duties', () => {
  it('never lets the subject decide, whatever seat resolves to them (falls back when nobody else remains)', () => {
    const selfManaged = ctx({ chain: [{ primary: cand(U.subject), secondary: null }] });
    const r = resolveStepActors(step(), selfManaged);
    expect(users(r)).toEqual([U.hr1, U.hr2]);
    expect(r.path).toBe('hr_admin');
    expect(r.reason).toMatch(/subject excluded/);
    // a delegate acting for the subject is excluded too
    const viaSubject = resolveStepActors(step({ approverType: 'USER', userId: U.subject }), ctx({ delegateOf: (u) => (u === U.subject ? U.delegate : null) }));
    expect(users(viaSubject)).not.toContain(U.delegate);
  });
  it('drops the requester at every rung, keeping them only as the last resort for a request about somebody else', () => {
    const c = ctx({ requestedBy: U.hr1 });
    expect(users(resolveStepActors(step({ approverType: 'ROLE', roleId: 'role-hr' }), c))).toEqual([U.hr2]);
    // the only HR admin filed it: the ladder continues to the owner rather than letting them decide their own filing
    const only = ctx({ requestedBy: U.hr1, hrAdminUserIds: [U.hr1] });
    const up = resolveStepActors(step({ approverType: 'HR_ADMIN' }), only);
    expect(users(up)).toEqual([U.owner]);
    expect(up.path).toBe('owner');
    expect(up.reason).toMatch(/requester excluded/);
    // the only owner filed it and nobody else exists: kept — somebody has to decide a request about an employee
    const alone = ctx({ requestedBy: U.owner, hrAdminUserIds: [], ownerUserIds: [U.owner] });
    const kept = resolveStepActors(step({ approverType: 'HR_ADMIN' }), alone);
    expect(users(kept)).toEqual([U.owner]);
    expect(kept.reason).toMatch(/requester kept/);
    // no subject (a request about nobody in particular): never kept — unresolved, the caller refuses the submission
    const noSubject = ctx({ requestedBy: U.owner, subjectEmployeeId: null, subjectUserId: null, hrAdminUserIds: [], ownerUserIds: [U.owner] });
    expect(resolveStepActors(step({ approverType: 'HR_ADMIN' }), noSubject)).toMatchObject({ path: 'unresolved', unresolved: true });
  });
  it('P0-3 no switch lifts the exclusion: a workflow flag passed along is ignored and the subject is never seated', () => {
    // a v1-era caller that still passes the removed flag gets exactly the default behaviour
    const legacy = { ...ctx(), allowSelfApproval: true } as ResolutionContext;
    const r = resolveStepActors(step({ approverType: 'USER', userId: U.subject }), legacy);
    expect(users(r)).not.toContain(U.subject);
    expect(r.path).toBe('hr_admin');
    expect(r.reason).toMatch(/subject excluded/);
  });
  it('P1-7 seats the subject when they are the organisation\'s only owner and nobody else can decide (owner bypass)', () => {
    // a single-owner organisation, no HR admin: the owner's own leave or correction
    const single = ctx({ subjectUserId: U.owner, requestedBy: U.owner, hrAdminUserIds: [], ownerUserIds: [U.owner], chain: [], permissionHolderUserIds: (p) => (p === 'leave.approve' ? [U.owner] : []) });
    const own = resolveStepActors(step({ approverType: 'ROLE', permission: 'leave.approve' }), single);
    expect(own.actors).toEqual([{ userId: U.owner, viaDelegationOf: null }]);
    expect(own.path).toBe('owner');
    expect(own.reason).toMatch(/subject kept/);
    // HR recorded it for the owner (the requester is somebody else, and not an owner): still the owner, never unresolved
    const filedByHr = resolveStepActors(step({ approverType: 'HR_ADMIN' }), { ...single, requestedBy: U.hr1 });
    expect(users(filedByHr)).toEqual([U.owner]);
    // the owner's delegate never acts for them on a request about them
    const withDelegate = resolveStepActors(step({ approverType: 'HR_ADMIN' }), { ...single, delegateOf: (u) => (u === U.owner ? U.delegate : null) });
    expect(withDelegate.actors).toEqual([{ userId: U.owner, viaDelegationOf: null }]);
    // a second owner exists: that owner decides, the subject stays excluded
    const two = resolveStepActors(step({ approverType: 'HR_ADMIN' }), { ...single, ownerUserIds: [U.owner, U.head] });
    expect(users(two)).toEqual([U.head]);
    // a subject who is not an owner is never kept
    const notOwner = resolveStepActors(step({ approverType: 'HR_ADMIN' }), ctx({ hrAdminUserIds: [], ownerUserIds: [U.owner], requestedBy: U.owner, subjectUserId: U.subject }));
    expect(users(notOwner)).not.toContain(U.subject);
  });
  it('P2-5 reports a suspended manager as such, not as "no linked login"', () => {
    const suspended = resolveStepActors(step(), ctx({ chain: [{ primary: { employeeId: 'e-m', userId: U.gone, absent: true, absentReason: 'membership suspended' }, secondary: cand(U.secondary) }] }));
    expect(suspended.path).toBe('secondary');
    expect(suspended.reason).toMatch(/primary manager: membership suspended/);
    expect(suspended.reason).not.toMatch(/no linked login/);
    const unlinked = resolveStepActors(step(), ctx({ chain: [{ primary: cand(null), secondary: cand(U.secondary) }] }));
    expect(unlinked.reason).toMatch(/primary manager: no linked login/);
  });
  it('keeps one row per person per level: an approver who is also another approver\'s delegate sits in their own seat', () => {
    const r = resolveStepActors(step({ approverType: 'HR_ADMIN', mode: 'ALL' }), ctx({ delegateOf: (u) => (u === U.hr1 ? U.hr2 : null) }));
    expect(r.actors).toEqual([{ userId: U.hr1, viaDelegationOf: null }, { userId: U.hr2, viaDelegationOf: null }]);
    expect(r.seatCount).toBe(2);
  });
  it('counts seats, not rows, for quorum requirements', () => {
    const r = resolveStepActors(step({ approverType: 'ROLE', roleId: 'role-hr', mode: 'QUORUM', requiredCount: 2 }), ctx({ delegateOf: (u) => (u === U.hr1 ? U.delegate : null) }));
    expect(r.actors).toHaveLength(3);
    expect(r.seatCount).toBe(2);
    expect(r.requiredCount).toBe(2);
    expect(resolveStepActors(step({ approverType: 'ROLE', roleId: 'role-hr', mode: 'ALL' }), ctx()).requiredCount).toBeNull();
  });
});

/**
 * HR portal Prompt 4 review, P0-2: the colleague on the other side of a shift swap is a CO-SUBJECT of the request. They never
 * decide it, whichever rung of the ladder they sit on (primary / secondary manager, HR admin, role, delegate); the rung falls
 * through to the next one; the owner exception applies to them exactly as to the subject.
 */
describe('resolveStepActors — co-subjects (4-P0-2)', () => {
  const colleague = { employeeId: 'e-colleague', userId: 'u-colleague' };
  const withColleague = (over: Partial<ResolutionContext> = {}) => ctx({ coSubjectEmployeeIds: [colleague.employeeId], coSubjectUserIds: [colleague.userId], activeUserIds: new Set([...Object.values(U), colleague.userId]), ...over });

  it('4-P0-2 the swapped colleague is never seated as the primary manager: the secondary manager stands in', () => {
    const r = resolveStepActors(step(), withColleague({ chain: [{ primary: cand(colleague.userId, colleague.employeeId), secondary: cand(U.secondary) }] }));
    expect(users(r)).toEqual([U.secondary]);
    expect(r.path).toBe('secondary');
    expect(r.reason).toMatch(/party to the request/);
  });
  it('4-P0-2 the swapped colleague is never seated as the secondary stand-in: the ladder falls through to the HR admins', () => {
    const r = resolveStepActors(step(), withColleague({ chain: [{ primary: cand(null), secondary: cand(colleague.userId, colleague.employeeId) }] }));
    expect(users(r)).toEqual([U.hr1, U.hr2]);
    expect(r.path).toBe('hr_admin');
  });
  it('4-P0-2 a colleague linked by login only (another employee record) is still recognised, and no delegate acts in their seat', () => {
    const byLogin = resolveStepActors(step(), withColleague({ chain: [{ primary: cand(colleague.userId, 'e-other-record'), secondary: null }], delegateOf: (u) => (u === colleague.userId ? U.delegate : null) }));
    expect(users(byLogin)).toEqual([U.hr1, U.hr2]);
    // an absent colleague-manager whose delegate would normally stand in: still nobody in their seat
    const absent = resolveStepActors(step(), withColleague({ chain: [{ primary: cand(colleague.userId, colleague.employeeId, true, 'on approved leave'), secondary: null }], delegateOf: (u) => (u === colleague.userId ? U.delegate : null) }));
    expect(users(absent)).not.toContain(U.delegate);
    expect(users(absent)).toEqual([U.hr1, U.hr2]);
  });
  it('4-P0-2 the colleague is dropped from HR admins, roles and permission holders — and so is anybody acting as their delegate', () => {
    const hr = resolveStepActors(step({ approverType: 'HR_ADMIN' }), withColleague({ hrAdminUserIds: [colleague.userId, U.hr1] }));
    expect(users(hr)).toEqual([U.hr1]);
    expect(hr.reason).toMatch(/party to the request excluded/);
    const delegateOfColleague = resolveStepActors(step({ approverType: 'HR_ADMIN' }), withColleague({ hrAdminUserIds: [U.hr1], delegateOf: (u) => (u === U.hr1 ? colleague.userId : null) }));
    expect(delegateOfColleague.actors).toEqual([{ userId: U.hr1, viaDelegationOf: null }]);
    const perm = resolveStepActors(step({ approverType: 'ROLE', permission: 'leave.approve' }), withColleague({ permissionHolderUserIds: () => [colleague.userId, U.manager] }));
    expect(users(perm)).toEqual([U.manager]);
  });
  it('4-P0-2 only HR admins who are the colleague: the owner decides; a colleague who is the only owner is kept as the owner of last resort', () => {
    const onlyColleague = resolveStepActors(step({ approverType: 'HR_ADMIN' }), withColleague({ hrAdminUserIds: [colleague.userId] }));
    expect(users(onlyColleague)).toEqual([U.owner]);
    const ownerIsColleague = resolveStepActors(step({ approverType: 'HR_ADMIN' }), withColleague({ hrAdminUserIds: [], ownerUserIds: [colleague.userId] }));
    expect(users(ownerIsColleague)).toEqual([colleague.userId]);
    expect(ownerIsColleague.path).toBe('owner');
    expect(ownerIsColleague.reason).toMatch(/party to the request kept/);
    // another owner exists: that owner decides
    const twoOwners = resolveStepActors(step({ approverType: 'HR_ADMIN' }), withColleague({ hrAdminUserIds: [], ownerUserIds: [colleague.userId, U.owner] }));
    expect(users(twoOwners)).toEqual([U.owner]);
  });
  it('4-P0-2 without co-subjects nothing changes (the colleague as manager is seated when the request is not about them)', () => {
    const r = resolveStepActors(step(), ctx({ chain: [{ primary: cand(colleague.userId, colleague.employeeId), secondary: cand(U.secondary) }], activeUserIds: new Set([...Object.values(U), colleague.userId]) }));
    expect(users(r)).toEqual([colleague.userId]);
  });
});

describe('resolveStepActors — four-eyes (review 5-O3)', () => {
  it('5-O3 somebody who approved an earlier level never holds a later seat: the rung falls through like the subject\'s', () => {
    // the primary manager approved level 1: the secondary manager takes the reporting line's seat
    const line = resolveStepActors(step(), ctx({ priorApproverUserIds: [U.manager] }));
    expect(users(line)).toEqual([U.secondary]);
    expect(line.path).toBe('secondary');
    expect(line.reason).toMatch(/four-eyes/);
    // both managers approved earlier levels: the HR admins
    expect(users(resolveStepActors(step(), ctx({ priorApproverUserIds: [U.manager, U.secondary] })))).toEqual([U.hr1, U.hr2]);
    // a named user who approved an earlier level: the ladder's next rung
    const named = resolveStepActors(step({ approverType: 'USER', userId: U.named }), ctx({ priorApproverUserIds: [U.named] }));
    expect(users(named)).toEqual([U.hr1, U.hr2]);
    expect(named.path).toBe('hr_admin');
  });
  it('5-O3 dropped from HR admins, roles and permission holders — with anybody acting in their seat', () => {
    const hr = resolveStepActors(step({ approverType: 'HR_ADMIN' }), ctx({ priorApproverUserIds: [U.hr1], delegateOf: (u) => (u === U.hr1 ? U.delegate : null) }));
    expect(hr.actors).toEqual([{ userId: U.hr2, viaDelegationOf: null }]);
    expect(hr.reason).toMatch(/approved an earlier level excluded/);
    // the A3 probe's shape: the line manager approved level 1 and is an HR admin's delegate on level 2
    const role = resolveStepActors(step({ approverType: 'ROLE', roleId: 'role-hr' }), ctx({ priorApproverUserIds: [U.manager], delegateOf: (u) => (u === U.hr1 ? U.manager : null) }));
    expect(role.actors).toEqual([{ userId: U.hr1, viaDelegationOf: null }, { userId: U.hr2, viaDelegationOf: null }]);
    const perm = resolveStepActors(step({ approverType: 'ROLE', permission: 'leave.approve' }), ctx({ priorApproverUserIds: [U.hr1, U.manager] }));
    expect(users(perm)).toEqual([U.owner]);
  });
  it('5-O3 the owner is kept as the approver of last resort when nobody else at all remains', () => {
    const r = resolveStepActors(step({ approverType: 'HR_ADMIN' }), ctx({ hrAdminUserIds: [U.hr1], priorApproverUserIds: [U.hr1, U.owner] }));
    expect(users(r)).toEqual([U.owner]);
    expect(r.path).toBe('owner');
    expect(r.reason).toMatch(/four-eyes override/);
  });
  it('5-O3 nothing changes without earlier approvals', () => {
    expect(users(resolveStepActors(step(), ctx({ priorApproverUserIds: [] })))).toEqual([U.manager]);
    expect(users(resolveStepActors(step({ approverType: 'HR_ADMIN' }), ctx()))).toEqual([U.hr1, U.hr2]);
  });
});
