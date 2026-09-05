import type { InvitationDto, MemberDto } from '@flowza/contracts';
import { isoDateTime, isoDateTimeOrNull } from '../lib/mappers.js';

export interface MemberRow {
  id: string; organizationId: string; userId: string; roleId: string; status: MemberDto['status']; allBranches: boolean; employeeId: string | null;
  joinedAt: Date | null; createdAt: Date; updatedAt: Date;
  email: string | null; fullName: string | null; avatarPath: string | null; lastLoginAt: Date | null;
  roleKey: string; roleName: string; employeeNumber: string | null;
}

export function toMemberDto(row: MemberRow, branches: { id: string; name: string }[]): MemberDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    email: row.email ?? '',
    fullName: row.fullName ?? '',
    avatarPath: row.avatarPath,
    roleId: row.roleId,
    roleKey: row.roleKey,
    roleName: row.roleName,
    status: row.status,
    allBranches: row.allBranches,
    branchIds: row.allBranches ? [] : branches.map((b) => b.id),
    branchNames: row.allBranches ? [] : branches.map((b) => b.name),
    employeeId: row.employeeId,
    employeeNumber: row.employeeNumber,
    lastLoginAt: isoDateTimeOrNull(row.lastLoginAt),
    joinedAt: isoDateTimeOrNull(row.joinedAt),
    createdAt: isoDateTime(row.createdAt),
    updatedAt: isoDateTime(row.updatedAt),
  };
}

export interface InvitationRow {
  id: string; organizationId: string; email: string; roleId: string; allBranches: boolean; branchIds: string[]; invitedBy: string | null;
  expiresAt: Date; acceptedAt: Date | null; createdAt: Date; roleName?: string | null; invitedByName?: string | null;
}

export function toInvitationDto(row: InvitationRow, extra: { token?: string; membershipId?: string | null } = {}): InvitationDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    roleId: row.roleId,
    roleName: row.roleName ?? undefined,
    allBranches: row.allBranches,
    branchIds: row.branchIds ?? [],
    invitedBy: row.invitedBy,
    invitedByName: row.invitedByName ?? null,
    expiresAt: isoDateTime(row.expiresAt),
    acceptedAt: isoDateTimeOrNull(row.acceptedAt),
    createdAt: isoDateTime(row.createdAt),
    ...(extra.token ? { token: extra.token } : {}),
    ...(extra.membershipId !== undefined ? { membershipId: extra.membershipId } : {}),
  };
}
