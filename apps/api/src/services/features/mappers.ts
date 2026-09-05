import type { DeviceDto, SyncJobDto, SyncJobItemDto, AttendanceDailyRecordDto, ReportRequestDto } from '@flowza/contracts';
import { deviceCapabilitiesSchema } from '@flowza/contracts';
import type { DeviceCommandDto, DeviceGroupDto, DeviceLogDto, PendingDeviceDto } from '../../routes/v1/features/dto.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject, numberOrNull } from '../../lib/mappers.js';

export const DEVICE_COLUMNS = [
  'd.id', 'd.organizationId', 'd.branchId', 'b.name as branchName', 'd.code', 'd.name', 'd.providerKey', 'p.name as providerName', 'd.modelId', 'd.manufacturer', 'd.modelName', 'd.serialNumber',
  'd.timezone', 'd.integrationType', 'd.endpointUrl', 'd.config', 'd.capabilities', 'd.status', 'd.connectionStatus', 'd.lastHeartbeatAt', 'd.lastAttendanceSyncAt', 'd.lastEmployeeSyncAt',
  'd.lastSuccessfulCommunicationAt', 'd.lastErrorCode', 'd.lastError', 'd.firmwareVersion', 'd.offlineThresholdMinutes', 'd.autoSyncEnabled', 'd.syncIntervalMinutes', 'd.tags', 'd.createdAt', 'd.updatedAt',
  'd.pushTokenHash', 'd.generation', 'd.notes', 'd.consecutiveFailures',
] as const;

export interface DeviceRow {
  id: string; organizationId: string; branchId: string; branchName: string | null; code: string; name: string; providerKey: string; providerName: string | null; modelId: string | null; manufacturer: string;
  modelName: string | null; serialNumber: string | null; timezone: string; integrationType: DeviceDto['integrationType']; endpointUrl: string | null; config: unknown; capabilities: unknown; status: DeviceDto['status'];
  connectionStatus: string; lastHeartbeatAt: Date | null; lastAttendanceSyncAt: Date | null; lastEmployeeSyncAt: Date | null; lastSuccessfulCommunicationAt: Date | null; lastErrorCode: string | null; lastError: string | null;
  firmwareVersion: string | null; offlineThresholdMinutes: number; autoSyncEnabled: boolean; syncIntervalMinutes: number; tags: string[]; createdAt: Date; updatedAt: Date; pushTokenHash: string | null; generation: number; notes: string | null; consecutiveFailures: number;
}

export type DeviceDtoExt = DeviceDto & { hasPushToken: boolean; generation: number; notes: string | null; consecutiveFailures: number };

export function toDeviceDto(r: DeviceRow, extra: { employeeCount?: number; maskedCredentials?: Record<string, unknown> } = {}): DeviceDtoExt {
  const caps = deviceCapabilitiesSchema.safeParse(jsonObject(r.capabilities));
  return {
    id: r.id, organizationId: r.organizationId, branchId: r.branchId, ...(r.branchName ? { branchName: r.branchName } : {}), code: r.code, name: r.name, providerKey: r.providerKey,
    ...(r.providerName ? { providerName: r.providerName } : {}), modelId: r.modelId, manufacturer: r.manufacturer, modelName: r.modelName, serialNumber: r.serialNumber, timezone: r.timezone,
    integrationType: r.integrationType, endpointUrl: r.endpointUrl, config: jsonObject(r.config), capabilities: caps.success ? caps.data : deviceCapabilitiesSchema.parse({}),
    status: r.status, connectionStatus: (r.connectionStatus === 'vendor_degraded' ? 'degraded' : r.connectionStatus) as DeviceDto['connectionStatus'],
    lastHeartbeatAt: isoDateTimeOrNull(r.lastHeartbeatAt), lastAttendanceSyncAt: isoDateTimeOrNull(r.lastAttendanceSyncAt), lastEmployeeSyncAt: isoDateTimeOrNull(r.lastEmployeeSyncAt),
    lastSuccessfulCommunicationAt: isoDateTimeOrNull(r.lastSuccessfulCommunicationAt), lastErrorCode: r.lastErrorCode, lastError: r.lastError, firmwareVersion: r.firmwareVersion,
    offlineThresholdMinutes: r.offlineThresholdMinutes, autoSyncEnabled: r.autoSyncEnabled, syncIntervalMinutes: r.syncIntervalMinutes, tags: r.tags ?? [],
    ...(extra.employeeCount !== undefined ? { employeeCount: extra.employeeCount } : {}), ...(extra.maskedCredentials !== undefined ? { maskedCredentials: extra.maskedCredentials } : {}),
    createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt), hasPushToken: r.pushTokenHash !== null, generation: r.generation, notes: r.notes, consecutiveFailures: r.consecutiveFailures,
  };
}

export function toDeviceGroupDto(r: { id: string; organizationId: string; name: string; description: string | null; branchId: string | null; branchName?: string | null; color: string | null; createdAt: Date; updatedAt: Date }, deviceCount: number, deviceIds?: string[]): DeviceGroupDto {
  return { id: r.id, organizationId: r.organizationId, name: r.name, description: r.description, branchId: r.branchId, branchName: r.branchName ?? null, color: r.color, deviceCount, ...(deviceIds ? { deviceIds } : {}), createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt) };
}

export function toPendingDeviceDto(r: { id: string; providerKey: string; serialNumber: string; claimCode: string; organizationId: string | null; firstSeenAt: Date; lastSeenAt: Date; remoteIp: string | null; deviceInfo: unknown; claimedDeviceId: string | null }): PendingDeviceDto {
  return { id: r.id, providerKey: r.providerKey, serialNumber: r.serialNumber, claimCode: r.claimCode, organizationId: r.organizationId, firstSeenAt: isoDateTime(r.firstSeenAt), lastSeenAt: isoDateTime(r.lastSeenAt), remoteIp: r.remoteIp, deviceInfo: jsonObject(r.deviceInfo), claimedDeviceId: r.claimedDeviceId };
}

export function toDeviceLogDto(r: { id: string | number; deviceId: string; level: DeviceLogDto['level']; event: string; message: string | null; details: unknown; jobId: string | null; createdAt: Date }): DeviceLogDto {
  return { id: String(r.id), deviceId: r.deviceId, level: r.level, event: r.event, message: r.message, details: r.details === null || r.details === undefined ? null : jsonObject(r.details), jobId: r.jobId, createdAt: isoDateTime(r.createdAt) };
}

export function toDeviceCommandDto(r: { id: string; deviceId: string; sequence: string | number; commandType: string; payload: unknown; status: DeviceCommandDto['status']; syncJobItemId: string | null; result: unknown; createdAt: Date; sentAt: Date | null; ackedAt: Date | null; expiresAt: Date }): DeviceCommandDto {
  return { id: r.id, deviceId: r.deviceId, sequence: String(r.sequence), commandType: r.commandType, payload: jsonObject(r.payload), status: r.status, syncJobItemId: r.syncJobItemId, result: r.result === null || r.result === undefined ? null : jsonObject(r.result), createdAt: isoDateTime(r.createdAt), sentAt: isoDateTimeOrNull(r.sentAt), ackedAt: isoDateTimeOrNull(r.ackedAt), expiresAt: isoDateTime(r.expiresAt) };
}

export const SYNC_JOB_COLUMNS = ['j.id', 'j.jobType', 'j.trigger', 'j.scope', 'j.status', 'j.priority', 'j.itemsTotal', 'j.itemsSuccess', 'j.itemsFailed', 'j.itemsPending', 'j.itemsOffline', 'j.itemsUnsupported', 'j.recordsIngested', 'j.requestedBy', 'u.fullName as requestedByName', 'j.correlationId', 'j.errorCode', 'j.error', 'j.summary', 'j.queuedAt', 'j.startedAt', 'j.finishedAt', 'j.createdAt', 'j.branchId', 'j.parentJobId'] as const;
export interface SyncJobRow {
  id: string; jobType: SyncJobDto['jobType']; trigger: SyncJobDto['trigger']; scope: unknown; status: SyncJobDto['status']; priority: number; itemsTotal: number; itemsSuccess: number; itemsFailed: number; itemsPending: number; itemsOffline: number; itemsUnsupported: number;
  recordsIngested: number; requestedBy: string | null; requestedByName: string | null; correlationId: string; errorCode: string | null; error: string | null; summary: unknown; queuedAt: Date | null; startedAt: Date | null; finishedAt: Date | null; createdAt: Date; branchId: string | null; parentJobId: string | null;
}
export function toSyncJobDto(r: SyncJobRow): SyncJobDto & { branchId: string | null; parentJobId: string | null } {
  return {
    id: r.id, jobType: r.jobType, trigger: r.trigger, scope: jsonObject(r.scope), status: r.status, priority: r.priority, itemsTotal: r.itemsTotal, itemsSuccess: r.itemsSuccess, itemsFailed: r.itemsFailed, itemsPending: r.itemsPending,
    itemsOffline: r.itemsOffline, itemsUnsupported: r.itemsUnsupported, recordsIngested: r.recordsIngested, requestedBy: r.requestedBy, requestedByName: r.requestedByName ?? null, correlationId: r.correlationId, errorCode: r.errorCode, error: r.error,
    summary: r.summary === null || r.summary === undefined ? null : jsonObject(r.summary), queuedAt: isoDateTimeOrNull(r.queuedAt), startedAt: isoDateTimeOrNull(r.startedAt), finishedAt: isoDateTimeOrNull(r.finishedAt), createdAt: isoDateTime(r.createdAt), branchId: r.branchId, parentJobId: r.parentJobId,
  };
}

export const SYNC_ITEM_COLUMNS = ['i.id', 'i.syncJobId', 'i.deviceId', 'd.name as deviceName', 'd.code as deviceCode', 'i.employeeId', 'e.employeeNumber as employeeNumber', 'e.displayName as employeeName', 'i.operation', 'i.status', 'i.attempts', 'i.maxAttempts', 'i.nextAttemptAt', 'i.lastErrorCode', 'i.lastError', 'i.result', 'i.recordsIngested', 'i.startedAt', 'i.finishedAt'] as const;
export interface SyncItemRow {
  id: string; syncJobId: string; deviceId: string | null; deviceName: string | null; deviceCode: string | null; employeeId: string | null; employeeNumber: string | null; employeeName: string | null; operation: SyncJobItemDto['operation']; status: SyncJobItemDto['status'];
  attempts: number; maxAttempts: number; nextAttemptAt: Date | null; lastErrorCode: string | null; lastError: string | null; result: unknown; recordsIngested: number; startedAt: Date | null; finishedAt: Date | null;
}
export function toSyncItemDto(r: SyncItemRow): SyncJobItemDto {
  return {
    id: r.id, syncJobId: r.syncJobId, deviceId: r.deviceId, deviceName: r.deviceName, deviceCode: r.deviceCode, employeeId: r.employeeId, employeeNumber: r.employeeNumber, employeeName: r.employeeName, operation: r.operation, status: r.status,
    attempts: r.attempts, maxAttempts: r.maxAttempts, nextAttemptAt: isoDateTimeOrNull(r.nextAttemptAt), lastErrorCode: r.lastErrorCode, lastError: r.lastError, result: r.result === null || r.result === undefined ? null : jsonObject(r.result), recordsIngested: r.recordsIngested, startedAt: isoDateTimeOrNull(r.startedAt), finishedAt: isoDateTimeOrNull(r.finishedAt),
  };
}

export const DAILY_RECORD_COLUMNS = ['r.id', 'r.employeeId', 'e.employeeNumber', 'e.displayName as employeeName', 'r.attendanceDate', 'r.branchId', 'b.name as branchName', 'r.departmentId', 'dp.name as departmentName', 'r.shiftId', 's.name as shiftName', 'r.timezone', 'r.expectedStartAt', 'r.expectedEndAt', 'r.scheduledMinutes', 'r.firstInAt', 'r.lastOutAt', 'r.workedMinutes', 'r.breakMinutes', 'r.lateMinutes', 'r.earlyDepartureMinutes', 'r.overtimeMinutes', 'r.overtimeCategory', 'r.status', 'r.flags', 'r.punchCount', 'r.hasCorrection', 'r.calculationVersion', 'r.computedAt', 'r.lockedAt'] as const;
export interface DailyRecordRow {
  id: string; employeeId: string; employeeNumber: string; employeeName: string; attendanceDate: Date | string; branchId: string; branchName: string | null; departmentId: string | null; departmentName: string | null; shiftId: string | null; shiftName: string | null; timezone: string; expectedStartAt: Date | null; expectedEndAt: Date | null;
  scheduledMinutes: number; firstInAt: Date | null; lastOutAt: Date | null; workedMinutes: number; breakMinutes: number; lateMinutes: number; earlyDepartureMinutes: number; overtimeMinutes: number; overtimeCategory: string | null; status: AttendanceDailyRecordDto['status']; flags: string[]; punchCount: number; hasCorrection: boolean; calculationVersion: number; computedAt: Date; lockedAt: Date | null;
}
export function toDailyRecordDto(r: DailyRecordRow): AttendanceDailyRecordDto & { branchName: string | null; departmentName: string | null } {
  return {
    id: r.id, employeeId: r.employeeId, employeeNumber: r.employeeNumber, employeeName: r.employeeName, attendanceDate: isoDate(r.attendanceDate), branchId: r.branchId, branchName: r.branchName, departmentId: r.departmentId, departmentName: r.departmentName, shiftId: r.shiftId, shiftName: r.shiftName, timezone: r.timezone,
    expectedStartAt: isoDateTimeOrNull(r.expectedStartAt), expectedEndAt: isoDateTimeOrNull(r.expectedEndAt), scheduledMinutes: r.scheduledMinutes, firstInAt: isoDateTimeOrNull(r.firstInAt), lastOutAt: isoDateTimeOrNull(r.lastOutAt), workedMinutes: r.workedMinutes, breakMinutes: r.breakMinutes, lateMinutes: r.lateMinutes,
    earlyDepartureMinutes: r.earlyDepartureMinutes, overtimeMinutes: r.overtimeMinutes, overtimeCategory: r.overtimeCategory, status: r.status, flags: jsonArray<string>(r.flags), punchCount: r.punchCount, hasCorrection: r.hasCorrection, calculationVersion: r.calculationVersion, computedAt: isoDateTime(r.computedAt), lockedAt: isoDateTimeOrNull(r.lockedAt),
  };
}

export const REPORT_COLUMNS = ['r.id', 'r.reportType', 'r.format', 'r.parameters', 'r.status', 'r.rowCount', 'r.fileSizeBytes', 'r.error', 'r.requestedBy', 'u.fullName as requestedByName', 'r.createdAt', 'r.completedAt', 'r.expiresAt', 'r.filePath', 'r.branchId', 'r.queueJobId', 'r.startedAt'] as const;
export interface ReportRow { id: string; reportType: string; format: ReportRequestDto['format']; parameters: unknown; status: ReportRequestDto['status']; rowCount: number | null; fileSizeBytes: string | number | null; error: string | null; requestedBy: string | null; requestedByName: string | null; createdAt: Date; completedAt: Date | null; expiresAt: Date | null; filePath: string | null; branchId: string | null; queueJobId: string | number | null; startedAt: Date | null }
export function toReportDto(r: ReportRow): ReportRequestDto & { branchId: string | null; jobId: string | null; startedAt: string | null } {
  return {
    id: r.id, reportType: r.reportType as ReportRequestDto['reportType'], format: r.format, parameters: jsonObject(r.parameters) as ReportRequestDto['parameters'], status: r.status, rowCount: r.rowCount, fileSizeBytes: numberOrNull(r.fileSizeBytes), error: r.error, requestedBy: r.requestedBy, requestedByName: r.requestedByName ?? null,
    createdAt: isoDateTime(r.createdAt), completedAt: isoDateTimeOrNull(r.completedAt), expiresAt: isoDateTimeOrNull(r.expiresAt), downloadUrl: null, branchId: r.branchId, jobId: r.queueJobId === null ? null : String(r.queueJobId), startedAt: isoDateTimeOrNull(r.startedAt),
  };
}
