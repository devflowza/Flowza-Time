import { describe, expect, it } from 'vitest';
import { collapseSeats, escalationDueAt, evaluateLevel, isExtraHandRow, pendingSeats, requiredAfterReassign, seatMustBeNamed, seatOrder, type ActorDecisionRow } from './evaluate.js';

describe('evaluateLevel', () => {
  it('ANY: one approval satisfies; a rejection is terminal only when nobody is left to approve', () => {
    expect(evaluateLevel('ANY', 1, ['PENDING', 'PENDING'])).toBe('open');
    expect(evaluateLevel('ANY', 1, ['APPROVED', 'PENDING'])).toBe('satisfied');
    expect(evaluateLevel('ANY', 1, ['REJECTED', 'PENDING'])).toBe('open'); // non-terminal rejection
    expect(evaluateLevel('ANY', 1, ['REJECTED', 'REJECTED'])).toBe('rejected');
    expect(evaluateLevel('ANY', 1, ['REJECTED'])).toBe('rejected');
  });
  it('ALL: every seat must approve; one rejection ends it', () => {
    expect(evaluateLevel('ALL', null, ['APPROVED', 'PENDING'])).toBe('open');
    expect(evaluateLevel('ALL', null, ['APPROVED', 'APPROVED'])).toBe('satisfied');
    expect(evaluateLevel('ALL', null, ['APPROVED', 'REJECTED', 'PENDING'])).toBe('rejected');
  });
  it('QUORUM: n approvals; rejection terminal when approvals can no longer reach n', () => {
    expect(evaluateLevel('QUORUM', 2, ['APPROVED', 'PENDING', 'PENDING'])).toBe('open');
    expect(evaluateLevel('QUORUM', 2, ['APPROVED', 'APPROVED', 'PENDING'])).toBe('satisfied');
    expect(evaluateLevel('QUORUM', 2, ['APPROVED', 'REJECTED', 'PENDING'])).toBe('open');
    expect(evaluateLevel('QUORUM', 2, ['APPROVED', 'REJECTED', 'REJECTED'])).toBe('rejected');
    expect(evaluateLevel('QUORUM', 3, ['PENDING', 'REJECTED', 'PENDING'])).toBe('rejected'); // 2 seats left, 3 needed
  });
  it('treats a missing or zero quorum as one, and an empty level as open', () => {
    expect(evaluateLevel('QUORUM', null, ['APPROVED'])).toBe('satisfied');
    expect(evaluateLevel('QUORUM', 0, ['APPROVED'])).toBe('satisfied');
    expect(evaluateLevel('ANY', 1, [])).toBe('open');
  });
});

describe('collapseSeats', () => {
  it('merges a delegate row into the approver\'s seat; approval wins over rejection within a seat', () => {
    expect(collapseSeats([{ userId: 'm', viaDelegationOf: null, decision: 'PENDING' }, { userId: 'd', viaDelegationOf: 'm', decision: 'APPROVED' }])).toEqual(['APPROVED']);
    expect(collapseSeats([{ userId: 'm', viaDelegationOf: null, decision: 'REJECTED' }, { userId: 'd', viaDelegationOf: 'm', decision: 'PENDING' }])).toEqual(['REJECTED']);
    expect(collapseSeats([{ userId: 'a', viaDelegationOf: null, decision: 'PENDING' }, { userId: 'b', viaDelegationOf: null, decision: 'APPROVED' }]).sort()).toEqual(['APPROVED', 'PENDING']);
  });
  it('drops seats whose rows were all skipped', () => {
    expect(collapseSeats([{ userId: 'a', viaDelegationOf: null, decision: 'SKIPPED' }, { userId: 'b', viaDelegationOf: null, decision: 'APPROVED' }])).toEqual(['APPROVED']);
  });
});

describe('P0-1 / P2-13 one seat per decision', () => {
  it('an override or escalated decision counts for exactly the seat it names', () => {
    const rows = [
      { userId: 'hr1', viaDelegationOf: null, decision: 'SKIPPED' },
      { userId: 'hr2', viaDelegationOf: null, decision: 'PENDING' },
      { userId: 'hr3', viaDelegationOf: null, decision: 'PENDING' },
      { userId: 'boss', viaDelegationOf: null, onBehalfOfUserId: 'hr1', decision: 'APPROVED' },
    ];
    expect(collapseSeats(rows).sort()).toEqual(['APPROVED', 'PENDING', 'PENDING']);
    // ALL: one filled seat of three leaves the level open; QUORUM 2 as well; ANY settles
    expect(evaluateLevel('ALL', null, collapseSeats(rows))).toBe('open');
    expect(evaluateLevel('QUORUM', 2, collapseSeats(rows))).toBe('open');
    expect(evaluateLevel('ANY', 1, collapseSeats(rows))).toBe('satisfied');
  });
  it('lists the seats still waiting, in seat order: when the seat was first written, then its user id', () => {
    const submit = '2026-09-28T08:00:00.000Z'; // every seat of a level is written by the submitting transaction
    const rows: ActorDecisionRow[] = [
      { userId: 'm', viaDelegationOf: null, decision: 'PENDING', createdAt: submit },
      { userId: 'd', viaDelegationOf: 'm', decision: 'PENDING', createdAt: submit },
      { userId: 'a', viaDelegationOf: null, decision: 'APPROVED', createdAt: submit },
      { userId: 'b', viaDelegationOf: null, decision: 'PENDING', createdAt: submit },
      { userId: 'c', viaDelegationOf: null, decision: 'SKIPPED', createdAt: submit },
    ];
    expect(pendingSeats(rows)).toEqual(['b', 'm']);
    expect(seatOrder(rows)).toEqual(['a', 'b', 'c', 'm']);
    // the delegate decided for m: m's seat is no longer pending
    expect(pendingSeats([...rows.slice(0, 1), { userId: 'd', viaDelegationOf: 'm', decision: 'REJECTED', createdAt: submit }, ...rows.slice(2)])).toEqual(['b']);
    // a seat written later (a reassignment) comes after the level's own seats, whatever its user id
    expect(pendingSeats([...rows, { userId: '0-reassigned', viaDelegationOf: null, decision: 'PENDING', createdAt: new Date('2026-09-28T09:30:00Z') }])).toEqual(['b', 'm', '0-reassigned']);
  });

  it('P2-13 the seat order never depends on how the rows were read (rows written by one statement share their creation time)', () => {
    const at = new Date('2026-09-28T08:00:00Z');
    const rows: ActorDecisionRow[] = [
      { userId: 'hr-c', viaDelegationOf: null, decision: 'PENDING', createdAt: at },
      { userId: 'hr-a', viaDelegationOf: null, decision: 'PENDING', createdAt: at },
      { userId: 'hr-b', viaDelegationOf: null, decision: 'PENDING', createdAt: at },
      { userId: 'deputy', viaDelegationOf: 'hr-c', decision: 'PENDING', createdAt: at },
    ];
    const permutations = (xs: ActorDecisionRow[]): ActorDecisionRow[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    const seen = new Set(permutations(rows).map((p) => pendingSeats(p).join(',')));
    expect([...seen]).toEqual(['hr-a,hr-b,hr-c']);
    // the same with no creation time at all: the seat's user id alone
    expect(pendingSeats(rows.map(({ createdAt: _omit, ...r }) => r).reverse())).toEqual(['hr-a', 'hr-b', 'hr-c']);
  });

  it('never lists an extra hand (an escalated approver who has not decided); lists what is left once they fill a seat', () => {
    const at = '2026-09-28T08:00:00.000Z';
    const escalated = { userId: 'late', viaDelegationOf: null, resolutionPath: 'escalated', decision: 'PENDING', createdAt: '2026-09-29T08:00:00.000Z' };
    const rows: ActorDecisionRow[] = [
      { userId: 'hr-a', viaDelegationOf: null, resolutionPath: 'hr_admin', decision: 'PENDING', createdAt: at },
      { userId: 'hr-b', viaDelegationOf: null, resolutionPath: 'hr_admin', decision: 'PENDING', createdAt: at },
      escalated,
    ];
    expect(isExtraHandRow(escalated)).toBe(true);
    expect(pendingSeats(rows)).toEqual(['hr-a', 'hr-b']);
    const filled = [rows[0]!, { ...rows[1]!, decision: 'SKIPPED' }, { ...escalated, onBehalfOfUserId: 'hr-b', decision: 'APPROVED' }];
    expect(isExtraHandRow(filled[2]!)).toBe(false);
    expect(pendingSeats(filled)).toEqual(['hr-a']);
  });

  it('P2-13 a stand-in seated on the primary\'s seat (the secondary manager, or a delegate) is ONE seat with it, never a second one', () => {
    const at = '2026-09-28T08:00:00.000Z';
    const rows: ActorDecisionRow[] = [
      { userId: 'primary', viaDelegationOf: null, resolutionPath: 'primary', decision: 'PENDING', createdAt: at },
      { userId: 'secondary', viaDelegationOf: 'primary', resolutionPath: 'secondary', decision: 'PENDING', createdAt: at },
    ];
    expect(isExtraHandRow(rows[1]!)).toBe(false);
    expect(seatOrder(rows)).toEqual(['primary']);
    expect(pendingSeats(rows)).toEqual(['primary']);
    // so an override on such a level has one target and needs no name, whatever the mode
    expect(seatMustBeNamed('ALL', pendingSeats(rows).length)).toBe(false);
    // the stand-in deciding closes the seat for both
    expect(pendingSeats([rows[0]!, { ...rows[1]!, decision: 'APPROVED' }])).toEqual([]);
  });

  it('P2-13 an override names its seat on ALL / QUORUM levels with several waiting seats; ANY or a single seat has one target', () => {
    expect(seatMustBeNamed('ALL', 2)).toBe(true);
    expect(seatMustBeNamed('QUORUM', 3)).toBe(true);
    expect(seatMustBeNamed('ALL', 1)).toBe(false);
    expect(seatMustBeNamed('QUORUM', 1)).toBe(false);
    expect(seatMustBeNamed('ANY', 5)).toBe(false);
    expect(seatMustBeNamed('ALL', 0)).toBe(false);
  });
});

describe('P1-1 reassigning a level', () => {
  it('lowers the requirement to what the reassignee can complete, so an approval never produces a rejection', () => {
    // QUORUM 2 of 3, nobody approved yet, all three pending seats handed to one person
    const required = requiredAfterReassign('QUORUM', 2, 0);
    expect(required).toBe(1);
    expect(evaluateLevel('QUORUM', required, ['APPROVED'])).toBe('satisfied');
    // one seat already approved: the reassignee is the second approval
    expect(requiredAfterReassign('QUORUM', 2, 1)).toBe(2);
    expect(evaluateLevel('QUORUM', 2, ['APPROVED', 'APPROVED'])).toBe('satisfied');
    expect(evaluateLevel('QUORUM', 2, ['APPROVED', 'REJECTED', 'APPROVED'])).toBe('satisfied');
    // the reassignee rejecting still rejects when the quorum is out of reach
    expect(evaluateLevel('QUORUM', 2, ['APPROVED', 'REJECTED', 'REJECTED'])).toBe('rejected');
    expect(requiredAfterReassign('QUORUM', 3, 5)).toBe(3);
    expect(requiredAfterReassign('ANY', 1, 0)).toBe(1);
    expect(requiredAfterReassign('ALL', null, 2)).toBeNull();
    // ALL: the approved seats plus the reassignee — their approval completes it
    expect(evaluateLevel('ALL', null, ['APPROVED', 'APPROVED', 'APPROVED'])).toBe('satisfied');
  });
});

describe('escalationDueAt', () => {
  it('adds the configured hours to the activation time, null without escalation', () => {
    const at = new Date('2026-09-27T08:00:00Z');
    expect(escalationDueAt({ escalateAfterHours: 48, escalateTo: 'HR_ADMIN' }, at)?.toISOString()).toBe('2026-09-29T08:00:00.000Z');
    expect(escalationDueAt({ escalateAfterHours: 48 }, at)).toBeNull();
    expect(escalationDueAt({}, at)).toBeNull();
  });
});
