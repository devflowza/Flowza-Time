import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/layout/page-header';
import { GrantsTable } from '@/features/platform/components/grants-table';

export default function AdmGrantsPage() {
  const { t } = useTranslation('adm');
  return (
    <div className="page-container">
      <PageHeader title={t('grantsPage.title')} description={t('grantsPage.subtitle')} />
      <GrantsTable />
    </div>
  );
}
