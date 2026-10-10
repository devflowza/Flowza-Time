import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocationDto } from '@flowza/contracts';
import { ConfirmDialog } from '@/components/ui';
import { useLocationMutations } from '@/features/locations/api';
import { inUseCounts } from '@/features/locations/conflicts';
import { LOCATIONS_NS } from '@/features/locations/locale';
import type { LocationTree } from '@/features/locations/use-location-tree';
import { ApiError } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Callout } from './callout';

/** "a, b and c" in the reader's language. */
function joinList(lng: string | undefined, items: string[]): string {
  try { return new Intl.ListFormat(lng, { style: 'long', type: 'conjunction' }).format(items); } catch { return items.join(', '); }
}

/**
 * Archive a group / place location (DELETE locations/:id). The server refuses (409) while it has active children or an
 * active device, employee or geofence uses it; the counts it reports are said in the reader's language — "Site A is still
 * in use: 1 active location inside, 2 devices and 3 employees" — so they know what to move first.
 */
export function ArchiveLocationDialog({ node, tree, onClose }: { node: LocationDto; tree: LocationTree; onClose: () => void }) {
  const { t, i18n } = useTranslation(LOCATIONS_NS);
  const { archive } = useLocationMutations();
  const [error, setError] = useState<string | null>(null);
  const name = tree.nameOf(node);

  const explain = (e: unknown): string => {
    if (!(e instanceof ApiError)) return t('archive.failed');
    const counts = e.status === 409 ? inUseCounts(e.details) : [];
    if (counts.length === 0) return e.message || t('archive.failed');
    return t('archive.inUse', { name, items: joinList(i18n.resolvedLanguage ?? i18n.language, counts.map(({ kind, count }) => t(`archive.items.${kind}`, { count }))) });
  };

  return (
    <ConfirmDialog
      open onOpenChange={(o) => { if (!o) onClose(); }} title={t('archive.title', { name })} description={t('archive.description')} confirmLabel={t('archive.confirm')} destructive loading={archive.isPending}
      onConfirm={() => { setError(null); archive.mutate(node.id, { onSuccess: () => { toast.success(t('archive.archived', { name })); onClose(); }, onError: (e) => setError(explain(e)) }); }}
    >
      {error ? <Callout tone="error">{error}</Callout> : null}
    </ConfirmDialog>
  );
}
