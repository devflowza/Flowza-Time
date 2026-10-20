import { FileQuestion, PackageX, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from './empty-state';

/**
 * Where the member's role gives no access: a whole page (the route guards) or one part of a page (an API 403 in a table,
 * a tab or a card). A calm "permission denied" — never the red error with a retry and a request id, since a retry gets the
 * same answer and support has nothing to look up.
 */
export function PermissionDenied({ scope = 'page', className }: { scope?: 'page' | 'section'; className?: string }) {
  const { t } = useTranslation();
  return <EmptyState icon={ShieldOff} title={t('common.permissionDeniedTitle')} description={t(scope === 'page' ? 'common.permissionDenied' : 'common.permissionDeniedSection')} className={className} />;
}

/** A page the role cannot open, in the page frame (route guards). */
export function PermissionDeniedPage() {
  return <div className="page-container"><PermissionDenied /></div>;
}

/**
 * A record the API answers 404 for: deleted, or hidden by row-level security because it is outside the member's scope (another
 * branch, not a direct report). The API does not say which — on purpose — so neither does this; there is nothing to retry.
 */
export function RecordNotFound({ className }: { className?: string }) {
  const { t } = useTranslation();
  return <EmptyState icon={FileQuestion} title={t('common.recordNotFound')} description={t('common.recordNotFoundHint')} className={className} />;
}

/**
 * Modules the organisation does not have (plan, platform switch or lapsed subscription — migration 20260929000600): what the
 * route guard shows for the whole page, and what a part of a page shows when the API refuses it with MODULE_DISABLED.
 */
export function ModuleDisabled({ modules, className }: { modules: string[]; className?: string }) {
  const { t } = useTranslation();
  const names = modules.map((m) => t(`modules.${m}.name`, { defaultValue: m })).join(', ');
  return <EmptyState icon={PackageX} title={t('modules.disabledTitle', { names })} description={t('modules.disabledHint')} className={className} />;
}
