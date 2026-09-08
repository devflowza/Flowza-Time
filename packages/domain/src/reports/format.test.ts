import { describe, expect, it } from 'vitest';
import { dayList, formatClock, formatHoursCell, formatIsoDate, hoursColonMinutes, hoursDotMinutes, luxonDatePattern, minutesBetweenInstants, naturalCompare } from './format.js';

describe('hours notation', () => {
  it('prints hours.minutes, never a decimal — 9.45 is nine hours forty-five', () => {
    expect(hoursDotMinutes(585)).toBe('9.45');
    expect(hoursDotMinutes(60 * 14 + 15)).toBe('14.15');
    expect(hoursDotMinutes(7)).toBe('0.07');
    expect(hoursDotMinutes(0)).toBe('0.00');
    expect(hoursDotMinutes(-90)).toBe('-1.30');
    expect(hoursDotMinutes(null)).toBe('');
  });
  it('prints hours:minutes without a 24-hour cap', () => {
    expect(hoursColonMinutes(602)).toBe('10:02');
    expect(hoursColonMinutes(106 * 60)).toBe('106:00');
  });
  it('renders a dash for nothing and for zero unless asked otherwise', () => {
    expect(formatHoursCell(null, 'h.mm')).toBe('-');
    expect(formatHoursCell(0, 'h.mm')).toBe('-');
    expect(formatHoursCell(0, 'h.mm', { zeroAsValue: true })).toBe('0.00');
    expect(formatHoursCell(540, 'hh:mm')).toBe('9:00');
  });
});

describe('dates and clocks', () => {
  it('maps the tenant date format onto Luxon tokens', () => {
    expect(formatIsoDate('2017-11-01', luxonDatePattern('DD/MM/YYYY'))).toBe('01/11/2017');
    expect(formatIsoDate('2011-01-21', luxonDatePattern('MM/DD/YYYY'))).toBe('01/21/2011');
    expect(formatIsoDate('2017-11-01', luxonDatePattern('YYYY-MM-DD'))).toBe('2017-11-01');
    expect(formatIsoDate('2017-11-01', 'dd-MMM-yyyy')).toBe('01-Nov-2017');
    expect(formatIsoDate('2017-11-01', 'cccc, d MMMM, yyyy')).toBe('Wednesday, 1 November, 2017');
  });
  it('prints wall-clock time in the record zone, lower-case am/pm in 12-hour mode', () => {
    // 2017-11-01 04:39 UTC = 08:39 in Muscat
    expect(formatClock('2017-11-01T04:39:00Z', 'Asia/Muscat', '12h')).toBe('8:39 am');
    expect(formatClock('2017-11-01T17:16:00Z', 'Asia/Muscat', '12h')).toBe('9:16 pm');
    expect(formatClock('2017-11-01T04:39:00Z', 'Asia/Muscat', '24h')).toBe('08:39');
    expect(formatClock(null, 'Asia/Muscat', '24h')).toBe('');
  });
  it('measures spans in whole minutes', () => {
    expect(minutesBetweenInstants('2017-11-01T02:00:00Z', '2017-11-01T17:16:00Z')).toBe(916);
    expect(minutesBetweenInstants(null, '2017-11-01T17:16:00Z')).toBeNull();
  });
  it('lists days of the month the way the samples print them', () => {
    expect(dayList(['2017-11-13', '2017-11-06'])).toBe('06 13');
  });
});

describe('naturalCompare', () => {
  it('orders employee numbers numerically and letters after digits', () => {
    const ids = ['2076', 'OM190', '334', '2010', '1171', '2001', 'OM1096'];
    expect([...ids].sort(naturalCompare)).toEqual(['334', '1171', '2001', '2010', '2076', 'OM190', 'OM1096']);
  });
  it('is case-insensitive and stable for equal keys', () => {
    expect(naturalCompare('emp1', 'EMP1')).toBe(0);
    expect(naturalCompare('EMP2', 'EMP10')).toBeLessThan(0);
  });
});
