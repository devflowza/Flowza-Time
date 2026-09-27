import { describe, expect, it } from 'vitest';
import { collapseSeats, escalationDueAt, evaluateLevel } from './evaluate.js';

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

describe('escalationDueAt', () => {
  it('adds the configured hours to the activation time, null without escalation', () => {
    const at = new Date('2026-09-27T08:00:00Z');
    expect(escalationDueAt({ escalateAfterHours: 48, escalateTo: 'HR_ADMIN' }, at)?.toISOString()).toBe('2026-09-29T08:00:00.000Z');
    expect(escalationDueAt({ escalateAfterHours: 48 }, at)).toBeNull();
    expect(escalationDueAt({}, at)).toBeNull();
  });
});
