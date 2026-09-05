import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Lock, Plus, ShieldCheck } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { useCan } from '@/features/me/use-me';
import { useRoles } from '../api';

export function RolesTab() {
  const { t } = useTranslation('users');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const q = useRoles();
  const roles = [...(q.data ?? [])].sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('roles.hint')}</p>
        {can('role.manage') ? <Button size="sm" onClick={() => navigate('/users/roles/new')}><Plus /> {t('roles.create')}</Button> : null}
      </div>
      {q.isLoading ? <Skeleton className="h-64 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : roles.length === 0 ? <EmptyState icon={ShieldCheck} title={t('roles.empty')} /> : (
        <div className="rounded-lg border bg-card shadow-card">
          <Table>
            <TableHeader><TableRow><TableHead>{tc('common.name')}</TableHead><TableHead>{t('roles.key')}</TableHead><TableHead>{t('roles.type')}</TableHead><TableHead>{t('roles.permissions')}</TableHead><TableHead>{t('roles.members')}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {roles.map((r) => (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/users/roles/${r.id}`)}>
                  <TableCell><p className="font-medium">{r.name}</p>{r.description ? <p className="max-w-md truncate text-xs text-muted-foreground">{r.description}</p> : null}</TableCell>
                  <TableCell className="font-mono text-xs" dir="ltr">{r.key}</TableCell>
                  <TableCell>{r.isSystem ? <Badge variant="neutral"><Lock className="size-3" /> {t('roles.system')}</Badge> : <Badge variant="info">{t('roles.custom')}</Badge>}</TableCell>
                  <TableCell className="tnum">{fmtNumber(r.permissions.length)}</TableCell>
                  <TableCell className="tnum">{r.memberCount !== undefined ? fmtNumber(r.memberCount) : '—'}</TableCell>
                  <TableCell className="text-end"><ChevronRight className="inline size-4 text-muted-foreground rtl:rotate-180" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
