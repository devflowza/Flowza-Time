import { describe, expect, it } from 'vitest';
import { AVAILABLE_REPORT_TYPES, REPORT_TYPE_DEFINITIONS } from '@flowza/contracts';
import { REPORT_DEFINITIONS } from './index.js';

describe('report catalogue ↔ generators', () => {
  it('offers exactly the report types the worker can generate', () => {
    // The catalogue used to list thirteen types with no generator behind any of them; a request sat at QUEUED while the
    // job dead-lettered. The two lists are now the same list, checked here so it cannot drift apart again.
    expect([...AVAILABLE_REPORT_TYPES].sort()).toEqual(Object.keys(REPORT_DEFINITIONS).sort());
    for (const key of Object.keys(REPORT_DEFINITIONS)) expect(REPORT_TYPE_DEFINITIONS.find((d) => d.key === key)?.status).toBe('available');
  });
});
