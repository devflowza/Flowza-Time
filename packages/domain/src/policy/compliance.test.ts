import { describe, expect, it } from 'vitest';
import { attendanceRuleSetInputSchema, COUNTRY_RULE_PACKS, policyDefaultsFromPack } from '@flowza/contracts';
import { checkPolicyCompliance } from './compliance.js';

const draft = (over: Record<string, unknown> = {}) => attendanceRuleSetInputSchema.parse({ name: 'Office', effectiveFrom: '2026-01-01', ...over });

describe('checkPolicyCompliance', () => {
  it('a policy built from the pack raises no warning beyond Ramadan dates', () => {
    for (const pack of Object.values(COUNTRY_RULE_PACKS)) {
      const d = draft(policyDefaultsFromPack(pack));
      expect(checkPolicyCompliance(d, pack).filter((w) => w.severity === 'warning')).toEqual([]);
    }
  });

  it('Oman: rates below the law, a cap above it and a long shift are warned about', () => {
    const om = COUNTRY_RULE_PACKS.OM;
    const base = policyDefaultsFromPack(om);
    const d = draft({ ...base, overtimeMaxMinutesPerDay: 300, policy: { ...base.policy, overtime: { ...base.policy.overtime, rates: { regular: 1, weekly: 1.25, weeklyOff: 2, holiday: 2 } } } });
    const codes = checkPolicyCompliance(d, om, { shiftScheduledMinutes: [540] }).map((w) => `${w.code}:${w.field}`);
    expect(codes).toEqual(['OVERTIME_CAP_ABOVE_LAW:overtimeMaxMinutesPerDay', 'OVERTIME_RATE_BELOW_LAW:policy.overtime.rates.regular', 'SHIFT_LONGER_THAN_STATUTORY_DAY:shiftId']);
  });

  it('missing limits are informational', () => {
    const w = checkPolicyCompliance(draft(), COUNTRY_RULE_PACKS.AE);
    expect(w.every((x) => x.severity === 'info' || x.code === 'OVERTIME_RATE_BELOW_LAW')).toBe(true);
    expect(w.map((x) => x.code)).toEqual(expect.arrayContaining(['OVERTIME_CAP_MISSING', 'MAX_DAILY_WORK_MISSING', 'WEEKLY_THRESHOLD_MISSING', 'RAMADAN_NOT_CONFIGURED']));
  });
});
