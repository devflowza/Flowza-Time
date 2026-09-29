import { Bell, Building2, CalendarOff, Clock, CreditCard, FileText, Globe2, LayoutDashboard, Plug, RefreshCw, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { ModuleKey, Permission } from '@flowza/contracts';

export const SETTINGS_SECTIONS = ['general', 'dashboard', 'regional', 'attendance', 'sync', 'integrations', 'reports', 'notifications', 'security', 'subscription', 'leave'] as const;
export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number];
/**
 * `permission`: sections beyond `organization.view` (the layout hides the entry; the route guards it again). `module`: sections
 * of a switchable module (migration 20260929000600), hidden when the organisation does not have it.
 */
export const SETTINGS_NAV: { key: SettingsSectionKey; icon: LucideIcon; permission?: Permission; module?: ModuleKey }[] = [
  { key: 'general', icon: Building2 }, { key: 'dashboard', icon: LayoutDashboard }, { key: 'regional', icon: Globe2 }, { key: 'attendance', icon: Clock }, { key: 'sync', icon: RefreshCw, module: 'devices' },
  { key: 'integrations', icon: Plug, permission: 'integration.manage', module: 'finance_integration' }, { key: 'reports', icon: FileText },
  { key: 'notifications', icon: Bell }, { key: 'security', icon: ShieldCheck }, { key: 'subscription', icon: CreditCard },
  // leave v2 (HR portal Prompt 7): comp-off expiry
  { key: 'leave', icon: CalendarOff, module: 'leave' },
];
