import { Cpu, Inbox, KeyRound, ListChecks, type LucideIcon } from 'lucide-react';
import type { Permission } from '@flowza/contracts';

/** Devices & punches tabs, in display order. */
export const DEVICES_HUB_TABS = ['devices', 'pins', 'unmapped', 'punches'] as const;
export type DevicesHubTab = (typeof DEVICES_HUB_TABS)[number];

/** Path and permissions of each hub tab (routes.tsx gates the same keys). */
export const HUB_TAB_ROUTES: Record<DevicesHubTab, { to: string; icon: LucideIcon; permissions: Permission[] }> = {
  devices: { to: '/devices', icon: Cpu, permissions: ['device.view'] },
  pins: { to: '/devices/pin-mapping', icon: KeyRound, permissions: ['device.view', 'employee.view'] },
  unmapped: { to: '/devices/unmapped-punches', icon: Inbox, permissions: ['attendance.view_raw'] },
  punches: { to: '/devices/punch-log', icon: ListChecks, permissions: ['attendance.view_raw'] },
};
