import { Bell, Building2, Clock, CreditCard, FileText, Globe2, LayoutDashboard, Plug, RefreshCw, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { Permission } from '@flowza/contracts';

export const SETTINGS_SECTIONS = ['general', 'dashboard', 'regional', 'attendance', 'sync', 'integrations', 'reports', 'notifications', 'security', 'subscription'] as const;
export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number];
/** `permission`: sections beyond `organization.view` (the layout hides the entry; the route guards it again). */
export const SETTINGS_NAV: { key: SettingsSectionKey; icon: LucideIcon; permission?: Permission }[] = [
  { key: 'general', icon: Building2 }, { key: 'dashboard', icon: LayoutDashboard }, { key: 'regional', icon: Globe2 }, { key: 'attendance', icon: Clock }, { key: 'sync', icon: RefreshCw },
  { key: 'integrations', icon: Plug, permission: 'integration.manage' }, { key: 'reports', icon: FileText },
  { key: 'notifications', icon: Bell }, { key: 'security', icon: ShieldCheck }, { key: 'subscription', icon: CreditCard },
];
