import { z } from 'zod';
import type { DeviceEmployeeSyncStatus, EmploymentStatus } from '../enums.js';
import { paginationQuerySchema, uuidSchema } from '../common.js';

/**
 * PIN mapping (Devices & punches): which employee a device user id — the "PIN" a terminal reports with every punch — belongs
 * to. Two kinds, in the order the normaliser reads them:
 *   `device`  — one device: the device_employee_states row (a person's mapping is marked `manual` and survives device syncs);
 *   `default` — every device without a device mapping: the employee's own device user id (employees.device_user_id).
 */
export const PIN_MAPPING_SCOPES = ['device', 'default'] as const;
export type PinMappingScope = (typeof PIN_MAPPING_SCOPES)[number];

/** Same format as employees.device_user_id: the only ids an employee can carry as their default device user id. */
export const DEFAULT_DEVICE_USER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export const pinMappingListQuerySchema = paginationQuerySchema.extend({
  scope: z.enum(PIN_MAPPING_SCOPES).optional(),
  deviceId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  /** PIN, employee name or employee number */
  search: z.string().trim().max(100).optional(),
});
export type PinMappingListQuery = z.infer<typeof pinMappingListQuerySchema>;

export interface PinMappingDto {
  /** `device:<state row id>` or `default:<employee id>` — unique across both kinds. */
  id: string;
  scope: PinMappingScope;
  /** Device state row id (device mappings only): DELETE /pin-mappings/:stateId removes the mapping. */
  stateId: string | null;
  deviceUserId: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceCode: string | null;
  deviceSerial: string | null;
  providerKey: string | null;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  employmentStatus: EmploymentStatus;
  /** Device branch for device mappings, employee branch for defaults. */
  branchId: string | null;
  /** Device mappings only. */
  syncStatus: DeviceEmployeeSyncStatus | null;
  desired: boolean | null;
  /** A person mapped it (device mappings only; defaults are always the employee record's own id). */
  manual: boolean;
  mappedAt: string | null;
  updatedAt: string;
}

export const createPinMappingSchema = z.object({
  employeeId: uuidSchema,
  deviceUserId: z.string().trim().min(1).max(64),
  /** The device the PIN belongs to; null = the employee's default device user id on every device. */
  deviceId: uuidSchema.nullable(),
  /**
   * Device mappings only: move the PIN from the employee it is mapped to on the device, and the employee from the PIN they are
   * mapped to there. Without it both are a 409 CONFLICT (`details.reason` PIN_TAKEN / EMPLOYEE_MAPPED) the UI can confirm.
   */
  replace: z.boolean().optional(),
});
export type CreatePinMappingInput = z.infer<typeof createPinMappingSchema>;

export const PIN_MAPPING_CONFLICTS = ['PIN_TAKEN', 'EMPLOYEE_MAPPED'] as const;
export type PinMappingConflict = (typeof PIN_MAPPING_CONFLICTS)[number];

export interface PinMappingResultDto {
  scope: PinMappingScope;
  employeeId: string;
  deviceId: string | null;
  deviceUserId: string;
  /** False when the mapping already existed. */
  changed: boolean;
  /** Default mappings: the employee's previous default id; device mappings: the PIN the employee was released from. */
  previousDeviceUserId: string | null;
  /** Unmatched punches of the PIN handed back to the normaliser. */
  rowsRequeued: number;
  /** Normaliser job (queue id) when rows were re-queued. */
  jobId: string | null;
}

export interface PinUnmapResultDto { stateId: string; deviceId: string; deviceUserId: string; employeeId: string; removed: boolean }
