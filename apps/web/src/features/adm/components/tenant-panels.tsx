import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Send, X } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@/components/ui';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgFeatureFlags, usePlatformMutations } from '@/features/platform/api';
import { useAdmMutations, usePlatformAdmins, useTenantAccount, useTenantMembers, useTenantNotes } from '../api';

const NONE = '__none__';

/** Platform-only account management: account manager (an active platform admin) and tags. */
export function TenantAccountCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation('adm');
  const q = useTenantAccount(orgId);
  const admins = usePlatformAdmins();
  const { putAccount } = useAdmMutations();
  const [tag, setTag] = useState('');
  const save = (input: Parameters<typeof putAccount.mutate>[0]['input']) => putAccount.mutate({ id: orgId, input }, { onSuccess: () => toast.success(t('tenant.account.saved')), onError: toastError });
  const tags = q.data?.tags ?? [];
  const addTag = () => {
    const v = tag.trim().toLowerCase();
    if (!v || tags.includes(v)) { setTag(''); return; }
    save({ tags: [...tags, v] });
    setTag('');
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t('tenant.account.title')}</CardTitle><CardDescription>{t('tenant.account.hint')}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? <Skeleton className="h-24 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
          <>
            <div className="space-y-1.5">
              <label htmlFor="account-manager" className="text-xs font-medium text-muted-foreground">{t('tenant.account.manager')}</label>
              <Select value={q.data?.accountManager?.userId ?? NONE} onValueChange={(v) => save({ accountManagerUserId: v === NONE ? null : v })} disabled={putAccount.isPending}>
                <SelectTrigger id="account-manager"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('tenant.account.none')}</SelectItem>
                  {(admins.data ?? []).filter((a) => a.status === 'active').map((a) => <SelectItem key={a.userId} value={a.userId}>{a.fullName || a.email} · {t(`levels.${a.level}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="account-tag" className="text-xs font-medium text-muted-foreground">{t('tenant.account.tags')}</label>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tg) => (
                  <Badge key={tg} variant="secondary" className="gap-1 font-normal">{tg}
                    <button type="button" className="rounded hover:text-destructive" aria-label={t('tenant.account.removeTag', { tag: tg })} onClick={() => save({ tags: tags.filter((x) => x !== tg) })}><X className="size-3" /></button>
                  </Badge>
                ))}
              </div>
              <Input id="account-tag" value={tag} maxLength={40} placeholder={t('tenant.account.tagsPlaceholder')} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
              <p className="text-xs text-muted-foreground">{t('tenant.account.tagsHint')}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Members and pending invitations of a tenant (directory data only). */
export function MembersPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const q = useTenantMembers(orgId);
  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>{t('members.title')}</CardTitle><CardDescription>{t('members.hint')}</CardDescription></CardHeader>
        <CardContent>
          {q.data.members.length === 0 ? <p className="text-sm text-muted-foreground">{t('members.empty')}</p> : (
            <div className="overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>{t('users.name')}</TableHead><TableHead>{t('members.role')}</TableHead><TableHead>{tc('common.status')}</TableHead><TableHead>{t('users.mfa')}</TableHead><TableHead>{t('members.lastLogin')}</TableHead><TableHead>{t('members.joined')}</TableHead></TableRow></TableHeader>
              <TableBody>{q.data.members.map((m) => (
                <TableRow key={m.membershipId}>
                  <TableCell><Link to={`/adm/users?user=${m.userId}`} className="block min-w-0 hover:underline"><span className="block truncate font-medium">{m.fullName || m.email}</span><span className="block truncate text-xs text-muted-foreground" dir="ltr">{m.email}</span></Link></TableCell>
                  <TableCell>{m.roleName}</TableCell>
                  <TableCell><Badge variant={m.status === 'active' ? 'success' : m.status === 'suspended' ? 'danger' : 'neutral'}>{t(`members.statuses.${m.status}`, { defaultValue: m.status })}</Badge></TableCell>
                  <TableCell>{m.mfaEnrolled ? <Badge variant="success">{t('mfaOn')}</Badge> : <Badge variant="neutral">{t('mfaOff')}</Badge>}</TableCell>
                  <TableCell className="text-xs tnum">{m.lastLoginAt ? fmtRelative(m.lastLoginAt) : t('members.never')}</TableCell>
                  <TableCell className="text-xs tnum">{fmtDateTime(m.joinedAt, 'UTC', 'dd MMM yyyy')}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table></div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('members.invitations')}</CardTitle></CardHeader>
        <CardContent>
          {q.data.invitations.length === 0 ? <p className="text-sm text-muted-foreground">{t('members.invitationsEmpty')}</p> : (
            <ul className="divide-y">{q.data.invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm" dir="ltr">{i.email}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">{i.roleName} · {i.expired ? <Badge variant="neutral">{t('members.expired')}</Badge> : <span className="tnum">{t('members.expires')} {fmtRelative(i.expiresAt)}</span>}</span>
              </li>
            ))}</ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Internal notes (append-only, platform-only). */
export function NotesPanel({ orgId }: { orgId: string }) {
  const { t } = useTranslation('adm');
  const q = useTenantNotes(orgId);
  const { addNote } = useAdmMutations();
  const [body, setBody] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    addNote.mutate({ id: orgId, input: { body: body.trim() } }, { onSuccess: () => { setBody(''); toast.success(t('notes.added')); }, onError: toastError });
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t('notes.title')}</CardTitle><CardDescription>{t('notes.hint')}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="space-y-2">
          <Textarea rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('notes.placeholder')} aria-label={t('notes.title')} />
          <div className="flex justify-end"><Button type="submit" size="sm" loading={addNote.isPending} disabled={!body.trim()}><Send className="rtl:rotate-180" /> {t('notes.add')}</Button></div>
        </form>
        {q.isLoading ? <Skeleton className="h-24 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('notes.empty')}</p> : (
          <ul className="space-y-3">
            {q.data?.map((n) => (
              <li key={n.id} className="rounded-lg border bg-muted/30 p-3">
                <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                <p className="mt-2 text-xs text-muted-foreground"><span dir="ltr">{n.authorLabel ?? n.authorUserId.slice(0, 8)}</span> · <span className="tnum" title={fmtDateTime(n.createdAt, 'UTC')}>{fmtRelative(n.createdAt)}</span></p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Per-tenant overrides of the platform feature-flag defaults. */
export function OrgFeatureFlagsCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation('platform');
  const q = useOrgFeatureFlags(orgId);
  const { putOrgFlags } = usePlatformMutations();
  const [pending, setPending] = useState<string | null>(null);
  const set = (key: string, value: boolean | null) => {
    setPending(key);
    putOrgFlags.mutate({ id: orgId, input: { flags: { [key]: value } } }, { onSuccess: () => toast.success(t('flags.saved')), onError: toastError, onSettled: () => setPending(null) });
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t('flags.title')}</CardTitle><CardDescription>{t('flags.hint')}</CardDescription></CardHeader>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-32 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (q.data?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">{t('flags.empty')}</p> : (
          <ul className="divide-y">
            {q.data?.map((f) => (
              <li key={f.key} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm"><span className="font-mono" dir="ltr">{f.key}</span>{f.override !== null ? <Badge variant="info" className="font-normal">{t('flags.override')}</Badge> : <Badge variant="outline" className="font-normal">{t(f.defaultEnabled ? 'flags.defaultOn' : 'flags.defaultOff')}</Badge>}</p>
                  <p className="text-xs text-muted-foreground">{f.description}</p>
                </div>
                {f.override !== null ? <Button size="sm" variant="ghost" onClick={() => set(f.key, null)} disabled={pending === f.key} aria-label={t('flags.reset', { key: f.key })}><RotateCcw /> {t('flags.resetShort')}</Button> : null}
                <Switch checked={f.effective} onCheckedChange={(v) => set(f.key, v)} disabled={pending === f.key} aria-label={t('flags.toggle', { key: f.key })} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
