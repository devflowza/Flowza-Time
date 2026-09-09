import { Bell, Building2, Clock, CreditCard, FileText, Globe2, LayoutDashboard, RefreshCw, ShieldCheck, type LucideIcon } from 'lucide-react';

export const SETTINGS_SECTIONS = ['general', 'dashboard', 'regional', 'attendance', 'sync', 'reports', 'notifications', 'security', 'subscription'] as const;
export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number];
export const SETTINGS_NAV: { key: SettingsSectionKey; icon: LucideIcon }[] = [
  { key: 'general', icon: Building2 }, { key: 'dashboard', icon: LayoutDashboard }, { key: 'regional', icon: Globe2 }, { key: 'attendance', icon: Clock }, { key: 'sync', icon: RefreshCw }, { key: 'reports', icon: FileText },
  { key: 'notifications', icon: Bell }, { key: 'security', icon: ShieldCheck }, { key: 'subscription', icon: CreditCard },
];
