import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, UsersRound, X } from 'lucide-react';
import { REPORT_RECIPIENT_MAX_ROLES, REPORT_RECIPIENT_MAX_USERS } from '@flowza/contracts';
import { Badge, ErrorState, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { cn } from '@/lib/utils';
import '../schedules-i18n';
import { useReportRecipients } from '../schedules-api';

export interface RecipientsValue { userIds: string[]; roleKeys: string[] }

/**
 * Recipients of a share or a schedule (HR portal Prompt 6a): line managers, whole roles (e.g. every HR admin — resolved at run
 * time, so a new HR admin receives the next run) and individual members. Each recipient later receives the report generated
 * under their OWN access scope; the picker says so, because "send to managers" never means "send my organisation-wide data".
 */
export function RecipientsPicker({ value, onChange, id = 'recipients', invalid }: { value: RecipientsValue; onChange: (v: RecipientsValue) => void; id?: string; invalid?: boolean }) {
  const { t } = useTranslation('reportSchedules');
  const q = useReportRecipients();
  const users = useMemo(() => q.data?.users ?? [], [q.data]);
  const byId = useMemo(() => new Map(users.map((u) => [u.userId, u])), [users]);
  const managers = useMemo(() => users.filter((u) => u.isManager), [users]);
  const userFull = value.userIds.length >= REPORT_RECIPIENT_MAX_USERS;
  const roleFull = value.roleKeys.length >= REPORT_RECIPIENT_MAX_ROLES;
  const toggleUser = (userId: string) => onChange({ ...value, userIds: value.userIds.includes(userId) ? value.userIds.filter((x) => x !== userId) : userFull ? value.userIds : [...value.userIds, userId] });
  const toggleRole = (key: string) => onChange({ ...value, roleKeys: value.roleKeys.includes(key) ? value.roleKeys.filter((x) => x !== key) : roleFull ? value.roleKeys : [...value.roleKeys, key] });
  const options = useMemo(() => users.filter((u) => !value.userIds.includes(u.userId)).map((u) => ({ value: u.userId, label: u.displayName, description: u.roleName })), [users, value.userIds]);

  if (q.isLoading) return <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-2/3" /></div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const chip = (on: boolean) => cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent');
  return (
    <div className={cn('space-y-3 rounded-md border p-3', invalid && 'border-destructive')} id={id} data-testid="recipients-picker">
      {managers.length ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('recipients.managers')}</p>
          <div className="flex flex-wrap gap-1.5">
            {managers.map((m) => <button key={m.userId} type="button" className={chip(value.userIds.includes(m.userId))} aria-pressed={value.userIds.includes(m.userId)} onClick={() => toggleUser(m.userId)}>{m.displayName}</button>)}
          </div>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t('recipients.roles')}</p>
        <div className="flex flex-wrap gap-1.5">
          {(q.data?.roles ?? []).map((r) => <button key={r.key} type="button" className={chip(value.roleKeys.includes(r.key))} aria-pressed={value.roleKeys.includes(r.key)} onClick={() => toggleRole(r.key)}><UsersRound className="size-3" /> {r.name} <span className="opacity-70 tnum">({r.members})</span></button>)}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t('recipients.people')}</p>
        <Combobox id={`${id}-user`} value={null} onChange={(v) => v && toggleUser(v)} options={options} disabled={userFull} placeholder={t('recipients.addPerson')} />
        {value.userIds.length ? (
          <div className="flex flex-wrap gap-1.5">
            {value.userIds.map((uid) => (
              <Badge key={uid} variant="secondary" className="gap-1 pe-1"><UserPlus className="size-3" />{byId.get(uid)?.displayName ?? uid.slice(0, 8)}
                <button type="button" className="rounded-full px-1 hover:bg-foreground/10" aria-label={t('recipients.remove', { name: byId.get(uid)?.displayName ?? uid })} onClick={() => toggleUser(uid)}><X className="size-3" /></button>
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('recipients.scopeNote')}</p>
    </div>
  );
}
