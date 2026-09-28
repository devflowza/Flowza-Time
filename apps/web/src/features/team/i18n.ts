import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/team.json';
import ar from '@/locales/ar/team.json';

/** Namespace of the team workspace (HR portal Prompt 5); imported by every module that renders its strings (the topbar chip too). */
export const TEAM_NS = 'team';
registerNamespace(TEAM_NS, en, ar);
