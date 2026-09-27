import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Avatar, Badge, Button, Card, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate, todayIso } from '@/lib/format';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useSelfProfile } from '../api';
import { tenure } from '../model';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-0.5 truncate text-sm font-medium">{children}</dd></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card className="p-5"><h2 className="mb-4 text-sm font-semibold">{title}</h2><dl className="grid gap-4 sm:grid-cols-2">{children}</dl></Card>;
}

/** /my/profile — the employee's own record, read-only (HR maintains it). */
export default function MyProfilePage() {
  const { t, i18n } = useTranslation('portal');
  const tz = useOrgTimezone();
  const can = useCan();
  const q = useSelfProfile();
  const p = q.data;
  const none = t('profile.none');
  if (q.isError) return <div className="page-container"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  if (!p) return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  const service = tenure(p.joiningDate, todayIso(tz));
  let region: Intl.DisplayNames | null = null;
  try { region = new Intl.DisplayNames([i18n.language || 'en'], { type: 'region' }); } catch { region = null; }

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('profile.title')} description={t('profile.subtitle')} actions={can('organization.view') ? <Button asChild variant="outline"><Link to="/settings/security"><ShieldCheck /> {t('profile.account')}</Link></Button> : undefined} />
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <Avatar name={p.displayName} src={p.photoUrl} className="size-16 text-lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xl font-semibold">{p.displayName}</p>
          {p.displayNameAr ? <p className="truncate text-sm text-muted-foreground" dir="rtl">{p.displayNameAr}</p> : null}
          <p className="mt-1 text-sm text-muted-foreground">{[p.designation?.name, p.department?.name].filter(Boolean).join(' · ') || none}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary" className="font-mono" dir="ltr">{p.employeeNumber}</Badge>
          <Badge variant={p.employmentStatus === 'active' ? 'success' : 'neutral'} dot>{t(`employmentStatus.${p.employmentStatus}`, { defaultValue: p.employmentStatus })}</Badge>
          <Badge variant="outline">{p.roleName}</Badge>
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title={t('profile.employment')}>
          <Field label={t('profile.designation')}>{p.designation?.name ?? none}</Field>
          <Field label={t('profile.department')}>{p.department?.name ?? none}</Field>
          <Field label={t('profile.manager')}>{p.manager ? <>{p.manager.name} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{p.manager.employeeNumber}</span></> : none}</Field>
          {p.secondaryManager ? <Field label={t('profile.secondaryManager')}>{p.secondaryManager.name} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{p.secondaryManager.employeeNumber}</span></Field> : null}
          <Field label={t('profile.teams')}>{p.teams.length ? p.teams.map((x) => x.name).join(', ') : none}</Field>
          <Field label={t('profile.joined')}><span className="tnum">{fmtDate(p.joiningDate)}</span></Field>
          <Field label={t('profile.tenure')}><span className="tnum">{t('profile.tenureValue', service)}</span></Field>
          <Field label={t('profile.employmentType')}>{p.employmentType ? t(`employmentType.${p.employmentType}`, { defaultValue: p.employmentType }) : none}</Field>
          <Field label={t('profile.employeeNumber')}><span className="font-mono" dir="ltr">{p.employeeNumber}</span></Field>
        </Section>
        <Section title={t('profile.workplace')}>
          <Field label={t('profile.branch')}>{p.branch?.name ?? none}</Field>
          <Field label={t('profile.timezone')}><span dir="ltr">{p.branch?.timezone ?? tz}</span></Field>
          <Field label={t('profile.weeklyOff')}>{p.weeklyOffDays.length ? p.weeklyOffDays.map((d) => t(`weekdaysLong.${d}`)).join(', ') : none}</Field>
          <Field label={t('profile.role')}>{p.roleName}</Field>
        </Section>
        <Section title={t('profile.personal')}>
          <Field label={t('profile.email')}><span dir="ltr">{p.email ?? none}</span></Field>
          <Field label={t('profile.phone')}><span dir="ltr" className="tnum">{p.phone ?? none}</span></Field>
          <Field label={t('profile.dateOfBirth')}><span className="tnum">{p.dateOfBirth ? fmtDate(p.dateOfBirth) : none}</span></Field>
          <Field label={t('profile.nationality')}>{p.nationality ? region?.of(p.nationality) ?? p.nationality : none}</Field>
          <Field label={t('profile.gender')}>{p.gender ? t(`gender.${p.gender}`, { defaultValue: p.gender }) : none}</Field>
        </Section>
      </div>
    </div>
  );
}
