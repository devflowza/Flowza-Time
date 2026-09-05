import type { BranchDto, DepartmentDto, DesignationDto, TeamDto } from '@flowza/contracts';
import { isoDateTime, jsonObject, numberOrNull } from '../lib/mappers.js';

export const BRANCH_COLUMNS = ['id', 'organizationId', 'code', 'name', 'nameAr', 'countryCode', 'city', 'address', 'timezone', 'latitude', 'longitude', 'geofenceRadiusM', 'contact', 'weeklyOffDays', 'holidayCalendarId', 'status', 'createdAt', 'updatedAt'] as const;
export interface BranchRow {
  id: string; organizationId: string; code: string; name: string; nameAr: string | null; countryCode: string; city: string | null; address: unknown; timezone: string;
  latitude: string | null; longitude: string | null; geofenceRadiusM: number | null; contact: unknown; weeklyOffDays: number[] | null; holidayCalendarId: string | null;
  status: BranchDto['status']; createdAt: Date; updatedAt: Date;
}
export function toBranchDto(r: BranchRow, employeeCount?: number): BranchDto {
  return {
    id: r.id, organizationId: r.organizationId, code: r.code, name: r.name, nameAr: r.nameAr, countryCode: r.countryCode, city: r.city, address: jsonObject(r.address), timezone: r.timezone,
    latitude: numberOrNull(r.latitude), longitude: numberOrNull(r.longitude), geofenceRadiusM: r.geofenceRadiusM, contact: jsonObject(r.contact), weeklyOffDays: r.weeklyOffDays,
    holidayCalendarId: r.holidayCalendarId, status: r.status, employeeCount, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
  };
}

export const DEPARTMENT_COLUMNS = ['d.id', 'd.organizationId', 'd.code', 'd.name', 'd.nameAr', 'd.branchId', 'd.parentId', 'd.managerEmployeeId', 'd.status', 'd.createdAt', 'd.updatedAt', 'b.name as branchName', 'm.displayName as managerName'] as const;
export interface DepartmentRow {
  id: string; organizationId: string; code: string; name: string; nameAr: string | null; branchId: string | null; parentId: string | null; managerEmployeeId: string | null;
  status: DepartmentDto['status']; createdAt: Date; updatedAt: Date; branchName: string | null; managerName: string | null;
}
export function toDepartmentDto(r: DepartmentRow, employeeCount?: number): DepartmentDto {
  return { id: r.id, organizationId: r.organizationId, code: r.code, name: r.name, nameAr: r.nameAr, branchId: r.branchId, branchName: r.branchName, parentId: r.parentId, managerEmployeeId: r.managerEmployeeId, managerName: r.managerName, status: r.status, employeeCount, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt) };
}

export const DESIGNATION_COLUMNS = ['id', 'organizationId', 'code', 'name', 'nameAr', 'level', 'status', 'createdAt', 'updatedAt'] as const;
export interface DesignationRow { id: string; organizationId: string; code: string; name: string; nameAr: string | null; level: number; status: DesignationDto['status']; createdAt: Date; updatedAt: Date }
export function toDesignationDto(r: DesignationRow): DesignationDto {
  return { id: r.id, organizationId: r.organizationId, code: r.code, name: r.name, nameAr: r.nameAr, level: r.level, status: r.status, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt) };
}

export const TEAM_COLUMNS = ['t.id', 't.organizationId', 't.code', 't.name', 't.branchId', 't.leadEmployeeId', 't.status', 't.createdAt', 't.updatedAt', 'b.name as branchName', 'l.displayName as leadName'] as const;
export interface TeamRow { id: string; organizationId: string; code: string; name: string; branchId: string | null; leadEmployeeId: string | null; status: TeamDto['status']; createdAt: Date; updatedAt: Date; branchName: string | null; leadName: string | null }
export function toTeamDto(r: TeamRow, memberCount: number, members?: TeamDto['members']): TeamDto {
  return { id: r.id, organizationId: r.organizationId, code: r.code, name: r.name, branchId: r.branchId, branchName: r.branchName, leadEmployeeId: r.leadEmployeeId, leadName: r.leadName, status: r.status, memberCount, members, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt) };
}
