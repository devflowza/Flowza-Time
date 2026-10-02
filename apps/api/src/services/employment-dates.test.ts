import { describe, expect, it } from 'vitest';
import { employmentDatesRecalcRange } from './employees.service.js';

const TODAY = '2026-10-02';

describe('employmentDatesRecalcRange', () => {
  it('a joining date moved back covers the old and the new date (field report: 2 Oct → 1 Sep)', () => {
    expect(employmentDatesRecalcRange({ joiningDate: '2026-10-02', exitDate: null }, { joiningDate: '2026-09-01', exitDate: null }, TODAY)).toEqual({ fromDate: '2026-09-01', toDate: '2026-10-02' });
  });

  it('a joining date moved forward turns the days before it into "not joined"', () => {
    expect(employmentDatesRecalcRange({ joiningDate: '2026-09-01', exitDate: null }, { joiningDate: '2026-09-15', exitDate: null }, TODAY)).toEqual({ fromDate: '2026-09-01', toDate: '2026-09-15' });
  });

  it('an exit date set, moved or cleared: an open exit counts as today; never past today', () => {
    expect(employmentDatesRecalcRange({ joiningDate: '2025-01-01', exitDate: null }, { joiningDate: '2025-01-01', exitDate: '2026-09-20' }, TODAY)).toEqual({ fromDate: '2026-09-20', toDate: TODAY });
    expect(employmentDatesRecalcRange({ joiningDate: '2025-01-01', exitDate: '2026-09-20' }, { joiningDate: '2025-01-01', exitDate: '2026-09-10' }, TODAY)).toEqual({ fromDate: '2026-09-10', toDate: '2026-09-20' });
    expect(employmentDatesRecalcRange({ joiningDate: '2025-01-01', exitDate: '2026-09-20' }, { joiningDate: '2025-01-01', exitDate: null }, TODAY)).toEqual({ fromDate: '2026-09-20', toDate: TODAY });
    expect(employmentDatesRecalcRange({ joiningDate: '2025-01-01', exitDate: null }, { joiningDate: '2025-01-01', exitDate: '2026-12-31' }, TODAY)).toEqual({ fromDate: TODAY, toDate: TODAY });
  });

  it('nothing to recalculate when neither date changed or the change lies wholly in the future', () => {
    expect(employmentDatesRecalcRange({ joiningDate: '2026-09-01', exitDate: null }, { joiningDate: '2026-09-01', exitDate: null }, TODAY)).toBeNull();
    expect(employmentDatesRecalcRange({ joiningDate: '2026-11-01', exitDate: null }, { joiningDate: '2026-12-01', exitDate: null }, TODAY)).toBeNull();
  });
});
