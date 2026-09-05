import { describe, expect, it } from 'vitest';
import { ProtocolError } from './errors.js';
import { assertBodySize, assertTimezone, boundedText, headerValue, isValidTimezone, MAX_INBOUND_BODY_BYTES, parseDeviceTime, queryValue, splitLines, toIsoUtc } from './protocol-utils.js';
import { ProviderError } from './types.js';

describe('protocol-utils', () => {
  it('interprets offset-less device time in the device timezone (Asia/Muscat = UTC+4)', () => {
    expect(toIsoUtc(parseDeviceTime('2026-03-10 08:30:00', 'Asia/Muscat'))).toBe('2026-03-10T04:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10T08:30:00', 'Asia/Muscat'))).toBe('2026-03-10T04:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10 08:30', 'Asia/Muscat'))).toBe('2026-03-10T04:30:00Z');
  });
  it('keeps an explicit offset, also in the space-separated form', () => {
    expect(toIsoUtc(parseDeviceTime('2026-03-10T08:30:00+02:00', 'Asia/Muscat'))).toBe('2026-03-10T06:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10T08:30:00Z', 'Asia/Muscat'))).toBe('2026-03-10T08:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10 08:30:00+04:00', 'Asia/Muscat'))).toBe('2026-03-10T04:30:00Z');
    expect(toIsoUtc(parseDeviceTime('2026-03-10 08:30:00Z', 'Asia/Muscat'))).toBe('2026-03-10T08:30:00Z');
  });
  it('rejects garbage with ProtocolError', () => {
    expect(() => parseDeviceTime('yesterday', 'Asia/Muscat')).toThrow(ProtocolError);
    expect(() => parseDeviceTime('2026-13-45 08:30:00', 'Asia/Muscat')).toThrow(ProtocolError);
  });
  it('treats an unknown timezone as INVALID_CONFIG (our configuration), not as a device protocol error', () => {
    const err = (() => { try { parseDeviceTime('2026-03-10 08:30:00', 'Mars/Olympus'); return undefined; } catch (e) { return e; } })();
    expect(ProviderError.is(err)).toBe(true);
    expect(ProtocolError.is(err)).toBe(false);
    expect((err as ProviderError).code).toBe('INVALID_CONFIG');
    expect(isValidTimezone('Asia/Muscat')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('')).toBe(false);
    expect(() => assertTimezone('Nope/Zone')).toThrow(ProviderError);
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
  it('refuses oversize bodies with HTTP 413 and bounds free-text fields', () => {
    expect(() => assertBodySize('x'.repeat(10), 10)).not.toThrow();
    const err = (() => { try { assertBodySize('é'.repeat(6), 10); return undefined; } catch (e) { return e as ProtocolError; } })();
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err?.httpStatus).toBe(413);
    expect(MAX_INBOUND_BODY_BYTES).toBe(1_048_576);
    expect(boundedText(undefined, 4)).toBeNull();
    expect(boundedText('abc', 4)).toBe('abc');
    expect(boundedText('abcdef', 4)).toBe('abcd');
  });
});
