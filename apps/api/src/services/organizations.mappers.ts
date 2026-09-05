import type { OrganizationDto } from '@flowza/contracts';
import { isoDateTime, jsonObject } from '../lib/mappers.js';

export const ORG_COLUMNS = ['id', 'companyCode', 'legalName', 'displayName', 'countryCode', 'timezone', 'currencyCode', 'locale', 'weeklyOffDays', 'logoPath', 'contact', 'address', 'status', 'createdAt', 'updatedAt', 'legalHold', 'regionCell'] as const;

export interface OrgRow {
  id: string; companyCode: string; legalName: string; displayName: string; countryCode: string; timezone: string; currencyCode: string;
  locale: string; weeklyOffDays: number[]; logoPath: string | null; contact: unknown; address: unknown; status: OrganizationDto['status'];
  createdAt: Date; updatedAt: Date; legalHold: boolean; regionCell: string;
}

export function toOrganizationDto(row: OrgRow): OrganizationDto {
  return {
    id: row.id,
    companyCode: row.companyCode,
    legalName: row.legalName,
    displayName: row.displayName,
    countryCode: row.countryCode,
    timezone: row.timezone,
    currencyCode: row.currencyCode,
    locale: row.locale,
    weeklyOffDays: row.weeklyOffDays ?? [],
    logoPath: row.logoPath,
    logoUrl: null,
    contact: jsonObject(row.contact),
    address: jsonObject(row.address),
    status: row.status,
    createdAt: isoDateTime(row.createdAt),
  };
}
