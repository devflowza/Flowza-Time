import { describe, expect, it } from 'vitest';
import { changedKeys, diffLines, prettyJson } from './json-diff';

describe('json-diff', () => {
  it('detects changed, added and removed top-level keys', () => {
    const keys = changedKeys({ a: 1, b: { x: 1 }, c: 'same' }, { a: 2, b: { x: 1 }, d: true, c: 'same' });
    expect([...keys].sort()).toEqual(['a', 'd']);
  });
  it('returns no keys for non-object values', () => {
    expect(changedKeys('x', null).size).toBe(0);
  });
  it('pretty prints and flags the lines of changed keys only', () => {
    const changed = changedKeys({ name: 'A', nested: { k: 1 } }, { name: 'B', nested: { k: 1 } });
    const lines = diffLines({ name: 'B', nested: { k: 1 } }, changed);
    expect(lines.find((l) => l.text.includes('"name"'))?.changed).toBe(true);
    expect(lines.find((l) => l.text.includes('"nested"'))?.changed).toBe(false);
    expect(lines.find((l) => l.text.includes('"k"'))?.changed).toBe(false);
  });
  it('re-formats JSON strings and leaves plain strings intact', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('hello')).toBe('hello');
    expect(prettyJson(null)).toBe('');
  });
});
