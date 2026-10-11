import type { LocationDto, LocationLevelDto, LocationLevelIcon, LocationLevelRole } from '@flowza/contracts';
import type { LocationRow } from '@flowza/database';
import { isoDateTime } from '../lib/mappers.js';

export const LEVEL_COLUMNS = ['id', 'organizationId', 'position', 'role', 'name', 'nameAr', 'icon', 'createdAt', 'updatedAt'] as const;
export interface LevelRow {
  id: string; organizationId: string; position: number; role: LocationLevelRole; name: string; nameAr: string | null; icon: string; createdAt: Date; updatedAt: Date;
}
export function toLocationLevelDto(r: LevelRow, locationCount: number): LocationLevelDto {
  return {
    id: r.id, organizationId: r.organizationId, position: Number(r.position), role: r.role, name: r.name, nameAr: r.nameAr, icon: r.icon as LocationLevelIcon,
    locationCount, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
  };
}

export interface LocationCounts { employeeCount: number; deviceCount: number; childCount: number }
/** A node of the tree (`loadLocationTree`: branch nodes already carry their branch's code, name and status) with its counts. */
export function toLocationDto(r: LocationRow, counts: LocationCounts): LocationDto {
  return {
    id: r.id, organizationId: r.organizationId, levelId: r.levelId, role: r.role, parentId: r.parentId, branchId: r.branchId,
    code: r.code, name: r.name, nameAr: r.nameAr, latitude: r.latitude, longitude: r.longitude, path: r.path, depth: r.depth, status: r.status,
    employeeCount: counts.employeeCount, deviceCount: counts.deviceCount, childCount: counts.childCount,
    createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
  };
}
