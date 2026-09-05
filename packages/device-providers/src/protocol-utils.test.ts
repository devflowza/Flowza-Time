import { describe, expect, it } from 'vitest';
import { ProtocolError } from './errors.js';
import { headerValue, parseDeviceTime, queryValue, splitLines, toIsoUtc } from './protocol-utils.js';

describe('protocol-utils', () => {
  it('interprets offset-less device time in the device timezone (Asia/Muscat = UTC+4)', () => {
    expect(toIsoUtc(parseDeviceTime('2026-03-10 08:30:00', 'Asia/Muscat'))).toBe('2026-03-10T04:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10T08:30:00', 'Asia/Muscat'))).toBe('2026-03-10T04:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10 08:30', 'Asia/Muscat'))).toBe('2026-03-10T04:30:00Z');
  });
  it('keeps an explicit offset', () => {
    expect(toIsoUtc(parseDeviceTime('2026-03-10T08:30:00+02:00', 'Asia/Muscat'))).toBe('2026-03-10T06:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10T08:30:00Z', 'Asia/Muscat'))).toBe('2026-03-10T08:30:00Z');
  });
  it('rejects garbage with ProtocolError', () => {
    expect(() => parseDeviceTime('yesterday', 'Asia/Muscat')).toThrow(ProtocolError);
    expect(() => parseDeviceTime('2026-13-45 08:30:00', 'Asia/Muscat')).toThrow(ProtocolError);
  });
  it('looks up headers and query case-insensitively', () => {
    expect(headerValue({ 'X-Mock-Signature': 'abc' }, 'x-mock-signature')).toBe('abc');
    expect(headerValue({}, 'x')).toBeUndefined();
    expect(queryValue({ sn: '1' }, 'SN')).toBe('1');
    expect(queryValue({ SN: '2', sn: '1' }, 'SN')).toBe('2');
  });
  it('splits CRLF/LF and drops blanks', () => {
    expect(splitLines('a\r\n\r\nb\n \nc')).toEqual(['a', 'b', 'c']);
  });
});
