import type { EmployeeDeviceStateDto, EmployeeDto, EmploymentHistoryDto, IdentityDocumentDto } from '@flowza/contracts';
import { isoDate, isoDateOrNull, isoDateTime, isoDateTimeOrNull, jsonObject } from '../lib/mappers.js';

/** Explicit column list for employee DTOs (never `select *`; pin_hash and search are never exposed). */
export const EMPLOYEE_COLUMNS = [
  'e.id', 'e.organizationId', 'e.employeeNumber', 'e.firstName', 'e.middleName', 'e.lastName', 'e.displayName', 'e.displayNameAr', 'e.photoPath', 'e.gender', 'e.dateOfBirth',
  'e.nationalityCode', 'e.email', 'e.phone', 'e.joiningDate', 'e.exitDate', 'e.employmentStatus', 'e.employmentType', 'e.branchId', 'e.departmentId', 'e.designationId',
  'e.managerEmployeeId', 'e.userId', 'e.deviceUserId', 'e.cardNumber', 'e.fingerprintEnrolled', 'e.faceEnrolled', 'e.weeklyOffDays', 'e.customFields', 'e.deletedAt', 'e.createdAt', 'e.updatedAt',
  'b.name as branchName', 'd.name as departmentName', 'g.name as designationName', 'mgr.displayName as managerName',
] as const;

export interface EmployeeRow {
  id: string; organizationId: string; employeeNumber: string; firstName: string; middleName: string | null; lastName: string; displayName: string; displayNameAr: string | null;
  photoPath: string | null; gender: EmployeeDto['gender']; dateOfBirth: Date | null; nationalityCode: string | null; email: string | null; phone: string | null;
  joiningDate: Date; exitDate: Date | null; employmentStatus: EmployeeDto['employmentStatus']; employmentType: EmployeeDto['employmentType'];
  branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null; userId: string | null; deviceUserId: string; cardNumber: string | null;
  fingerprintEnrolled: boolean; faceEnrolled: boolean; weeklyOffDays: number[] | null; customFields: unknown; deletedAt: Date | null; createdAt: Date; updatedAt: Date;
  branchName: string | null; departmentName: string | null; designationName: string | null; managerName: string | null;
}

export type DeviceSyncSummary = NonNullable<EmployeeDto['deviceSyncSummary']>;
export const EMPTY_SYNC_SUMMARY: DeviceSyncSummary = { total: 0, inSync: 0, pending: 0, failed: 0, offline: 0 };

export function toEmployeeDto(r: EmployeeRow, deviceSyncSummary?: DeviceSyncSummary): EmployeeDto {
  return {
    id: r.id, organizationId: r.organizationId, employeeNumber: r.employeeNumber, firstName: r.firstName, middleName: r.middleName, lastName: r.lastName, displayName: r.displayName,
    displayNameAr: r.displayNameAr, photoPath: r.photoPath, photoUrl: null, gender: r.gender, dateOfBirth: isoDateOrNull(r.dateOfBirth), nationalityCode: r.nationalityCode, email: r.email, phone: r.phone,
    joiningDate: isoDate(r.joiningDate), exitDate: isoDateOrNull(r.exitDate), employmentStatus: r.employmentStatus, employmentType: r.employmentType,
    branchId: r.branchId, branchName: r.branchName ?? undefined, departmentId: r.departmentId, departmentName: r.departmentName, designationId: r.designationId, designationName: r.designationName,
    managerEmployeeId: r.managerEmployeeId, managerName: r.managerName, userId: r.userId, deviceUserId: r.deviceUserId, cardNumber: r.cardNumber,
    fingerprintEnrolled: r.fingerprintEnrolled, faceEnrolled: r.faceEnrolled, weeklyOffDays: r.weeklyOffDays, customFields: jsonObject(r.customFields),
    deviceSyncSummary, deletedAt: isoDateTimeOrNull(r.deletedAt), createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
  };
}

export const HISTORY_COLUMNS = ['h.id', 'h.employeeId', 'h.effectiveFrom', 'h.effectiveTo', 'h.branchId', 'h.departmentId', 'h.designationId', 'h.managerEmployeeId', 'h.employmentType', 'h.employmentStatus', 'h.reason', 'h.createdBy', 'h.createdAt', 'b.name as branchName', 'd.name as departmentName', 'g.name as designationName', 'm.displayName as managerName'] as const;
export interface HistoryRow {
  id: string; employeeId: string; effectiveFrom: Date; effectiveTo: Date | null; branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null;
  employmentType: EmploymentHistoryDto['employmentType']; employmentStatus: EmploymentHistoryDto['employmentStatus']; reason: string | null; createdBy: string | null; createdAt: Date;
  branchName: string | null; departmentName: string | null; designationName: string | null; managerName: string | null;
}
export function toHistoryDto(r: HistoryRow): EmploymentHistoryDto {
  return {
    id: r.id, employeeId: r.employeeId, effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: isoDateOrNull(r.effectiveTo), branchId: r.branchId, branchName: r.branchName, departmentId: r.departmentId, departmentName: r.departmentName,
    designationId: r.designationId, designationName: r.designationName, managerEmployeeId: r.managerEmployeeId, managerName: r.managerName, employmentType: r.employmentType, employmentStatus: r.employmentStatus,
    reason: r.reason, createdBy: r.createdBy, createdAt: isoDateTime(r.createdAt),
  };
}

export interface DeviceStateRow {
  id: string; deviceId: string; deviceCode: string; deviceName: string; branchId: string | null; connectionStatus: string; deviceUserId: string; syncStatus: EmployeeDeviceStateDto['syncStatus']; desired: boolean;
  lastSyncAt: Date | null; lastSuccessAt: Date | null; lastErrorCode: string | null; lastError: string | null; fingerprintCount: number; faceEnrolled: boolean; cardEnrolled: boolean; updatedAt: Date;
}
export function toDeviceStateDto(r: DeviceStateRow): EmployeeDeviceStateDto {
  return {
    id: r.id, deviceId: r.deviceId, deviceCode: r.deviceCode, deviceName: r.deviceName, branchId: r.branchId, connectionStatus: r.connectionStatus, deviceUserId: r.deviceUserId, syncStatus: r.syncStatus, desired: r.desired,
    lastSyncAt: isoDateTimeOrNull(r.lastSyncAt), lastSuccessAt: isoDateTimeOrNull(r.lastSuccessAt), lastErrorCode: r.lastErrorCode, lastError: r.lastError, fingerprintCount: r.fingerprintCount, faceEnrolled: r.faceEnrolled, cardEnrolled: r.cardEnrolled, updatedAt: isoDateTime(r.updatedAt),
  };
}

export const DOCUMENT_COLUMNS = ['id', 'employeeId', 'type', 'number', 'issuingCountry', 'issuedAt', 'expiresAt', 'filePath', 'notes', 'createdBy', 'createdAt', 'updatedAt'] as const;
export interface DocumentRow { id: string; employeeId: string; type: IdentityDocumentDto['type']; number: string; issuingCountry: string | null; issuedAt: Date | null; expiresAt: Date | null; filePath: string | null; notes: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date }
export function toDocumentDto(r: DocumentRow): IdentityDocumentDto {
  return { id: r.id, employeeId: r.employeeId, type: r.type, number: r.number, issuingCountry: r.issuingCountry, issuedAt: isoDateOrNull(r.issuedAt), expiresAt: isoDateOrNull(r.expiresAt), filePath: r.filePath, notes: r.notes, createdBy: r.createdBy, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt) };
}
