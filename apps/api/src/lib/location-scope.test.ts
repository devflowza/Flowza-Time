import { describe, expect, it } from 'vitest';
import type { LocationFilter } from '@flowza/database';
import { narrowByLocation, NO_ROWS, placeReferenceError, type LocationNode } from './location-scope.js';

describe('narrowByLocation', () => {
  const group: LocationFilter = { kind: 'branches', locationId: 'g', branchIds: ['b1', 'b2', 'b1'] };
  const place: LocationFilter = { kind: 'places', locationId: 'p', branchId: 'b1', placeIds: ['p', 'p-child'] };

  it('a group / branch location: its branches inside the caller\'s scope, nothing selected as [NO_ROWS]', () => {
    expect(narrowByLocation(group, null)).toEqual({ branchIds: ['b1', 'b2'], placeIds: null });
    expect(narrowByLocation(group, ['b2', 'b3'])).toEqual({ branchIds: ['b2'], placeIds: null });
    expect(narrowByLocation(group, ['b3'])).toEqual({ branchIds: [NO_ROWS], placeIds: null });
    expect(narrowByLocation({ kind: 'branches', locationId: 'empty', branchIds: [] }, null)).toEqual({ branchIds: [NO_ROWS], placeIds: null });
  });

  it('a place: its branch inside the scope and the place subtree; outside the scope nothing at all', () => {
    expect(narrowByLocation(place, null)).toEqual({ branchIds: ['b1'], placeIds: ['p', 'p-child'] });
    expect(narrowByLocation(place, ['b1', 'b2'])).toEqual({ branchIds: ['b1'], placeIds: ['p', 'p-child'] });
    expect(narrowByLocation(place, ['b2'])).toEqual({ branchIds: [NO_ROWS], placeIds: [NO_ROWS] });
  });
});

describe('placeReferenceError', () => {
  const node = (extra: Partial<LocationNode> = {}): LocationNode => ({ id: 'p', role: 'place', branchId: 'b1', status: 'active', ...extra });
  const issue = (err: ReturnType<typeof placeReferenceError>) => (err?.details as { issues: Array<{ path: string; message: string }> } | undefined)?.issues[0];

  it('accepts an active place of the row\'s branch', () => {
    expect(placeReferenceError(node(), 'b1')).toBeNull();
  });

  it('names the field and the reason for everything else', () => {
    expect(issue(placeReferenceError(null, 'b1'))).toEqual({ path: 'locationId', message: 'Unknown location' });
    expect(issue(placeReferenceError(node({ role: 'group', branchId: null }), 'b1'))).toEqual({ path: 'locationId', message: 'Not a place' });
    expect(issue(placeReferenceError(node({ role: 'branch' }), 'b1'))).toEqual({ path: 'locationId', message: 'Not a place' });
    expect(issue(placeReferenceError(node({ status: 'archived' }), 'b1'))).toEqual({ path: 'locationId', message: 'Archived' });
    expect(issue(placeReferenceError(node(), null))).toEqual({ path: 'locationId', message: 'Needs a branch' });
    expect(issue(placeReferenceError(node(), 'b2', 'workLocationId'))).toEqual({ path: 'workLocationId', message: 'Another branch' });
    expect(placeReferenceError(node(), 'b2')?.code).toBe('VALIDATION_ERROR');
  });
});
