import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui';
import { useApprovalAccess } from '@/features/approvals/api';
import { DelegationsPanel } from '@/features/approvals/pages/delegations-page';
import { TEAM_NS } from '../i18n';

/** The Prompt 2 delegations list embedded in the team workspace: who decides for me while I am away (and for whom I decide). */
export function DelegationTab() {
  const { t } = useTranslation(TEAM_NS);
  const { t: ta } = useTranslation('approvals');
  const access = useApprovalAccess();
  const [creating, setCreating] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('delegation.hint')}</p>
        <Link to="/approvals/delegations" className="text-xs font-medium text-primary hover:underline">{t('delegation.manage')}</Link>
        {access.delegate ? <Button size="sm" onClick={() => setCreating(true)}><Plus /> {access.manage ? ta('delegations.addFor') : ta('delegations.add')}</Button> : null}
      </div>
      <DelegationsPanel creating={creating} onCreatingChange={setCreating} />
    </div>
  );
}
