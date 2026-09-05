import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { createEmployeeSchema, type CreateEmployeeInput } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeMutations } from '../api';
import { EmployeeFormFields, type EmployeeFormValues } from '../components/employee-form-fields';

export default function EmployeeNewPage() {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const tz = useOrgTimezone();
  const { create } = useEmployeeMutations();
  const form = useForm<EmployeeFormValues, unknown, CreateEmployeeInput>({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues: { employeeNumber: '', firstName: '', lastName: '', gender: 'unspecified', joiningDate: todayIso(tz), employmentStatus: 'active', employmentType: 'full_time', branchId: '' },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const created = await create.mutateAsync(values);
      toast.success(t('form.created', { name: created.displayName }));
      navigate(`/employees/${created.id}`);
    } catch (e) { toastError(e); }
  });
  return (
    <div className="page-container">
      <PageHeader title={t('form.newTitle')} description={t('form.newHint')} breadcrumbs={<Link to="/employees" className="inline-flex items-center gap-1 hover:underline"><ArrowLeft className="size-3 rtl:rotate-180" /> {t('title')}</Link>} />
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <EmployeeFormFields form={form} mode="create" />
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <Button type="button" variant="outline" onClick={() => navigate('/employees')}>{tc('common.cancel')}</Button>
          <Button type="submit" loading={form.formState.isSubmitting}>{t('form.create')}</Button>
        </div>
      </form>
    </div>
  );
}
