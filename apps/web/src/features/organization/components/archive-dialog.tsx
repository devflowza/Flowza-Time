import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UseMutationResult } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { toast } from '@/lib/toast';

/**
 * Archive confirmation shared by the structure tabs. The API refuses (409 CONFLICT) while the row is still in use;
 * that message is shown inline so the user knows what to move first.
 */
export function ArchiveDialog({ target, onClose, archive, title, description, successMessage }: {
  target: { id: string; name: string } | null; onClose: () => void; archive: UseMutationResult<unknown, unknown, string>; title: string; description: string; successMessage: string;
}) {
  const { t } = useTranslation('organization');
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog open={!!target} onOpenChange={(o) => { if (!o) { setError(null); onClose(); } }} title={title} description={description} confirmLabel={t('actions.archive')} destructive loading={archive.isPending}
      onConfirm={() => { if (!target) return; setError(null); archive.mutate(target.id, { onSuccess: () => { toast.success(successMessage); onClose(); }, onError: (e) => setError(e instanceof ApiError ? e.message : t('errors.archiveFailed')) }); }}>
      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-red-50 p-2 text-sm text-destructive dark:bg-red-950/30">{error}</p> : null}
    </ConfirmDialog>
  );
}
