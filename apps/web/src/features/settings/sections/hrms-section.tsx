import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import {
  API_KEY_DEFAULT_DAYS, API_KEY_MAX_DAYS, API_KEY_SCOPES, EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, GENDERS, HRMS_EMPLOYEE_FIELDS, HRMS_ORG_UNIT_FIELDS, HRMS_PRESETS, HRMS_PRESET_DEFINITIONS, hrmsPresetPairs,
  type ApiKeyCreatedDto, type ApiKeyDto, type ApiKeyScope, type HrmsIntegrationDto, type HrmsIntegrationInput, type HrmsMappingPair, type HrmsPreset,
} from '@flowza/contracts';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, fieldClass,
} from '@/components/ui';
import { fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { registerNamespace } from '@/lib/i18n-namespace';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import en from '@/locales/en/hrms.json';
import ar from '@/locales/ar/hrms.json';
import { useApiKeys, useHrmsBatches, useHrmsIntegration, useHrmsMutations } from '../hrms-api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

registerNamespace('hrms', en, ar);

/**
 * Settings → HR system (customer requirement: "integration with the Mawred Plus system to update employee data and
 * organisational units"; docs/integrations/hrms.md). Three cards: the feed (switch, preset, field mapping), the organisation's
 * API keys (a key's secret is shown once) and the latest batches. Everything needs `integration.manage`.
 */
export default function HrmsSection() {
  const { t } = useTranslation('hrms');
  const canManage = useCan()('integration.manage');
  const q = useHrmsIntegration(canManage);
  if (!canManage) return <Card><CardContent className="pt-5 text-sm text-muted-foreground">{t('noPermission')}</CardContent></Card>;
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <HrmsConfigForm key={JSON.stringify(q.data)} initial={q.data} />
      <ApiKeysCard />
      <HrmsBatchesCard />
    </>
  );
}

type Lists = Pick<HrmsIntegrationDto, 'employeeMapping' | 'orgUnitMapping' | 'statusMapping' | 'genderMapping' | 'employmentTypeMapping'>;
type ListKey = keyof Lists;

/** Client-side check before saving: blank rows dropped, a source named twice refused (the server says the same). */
function cleanPairs<T extends string>(pairs: ReadonlyArray<HrmsMappingPair<T>>): { pairs: Array<HrmsMappingPair<T>>; duplicate: string | null } {
  const out: Array<HrmsMappingPair<T>> = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const source = p.source.trim();
    if (!source) continue;
    if (seen.has(source.toLowerCase())) return { pairs: out, duplicate: source };
    seen.add(source.toLowerCase());
    out.push({ source, target: p.target });
  }
  return { pairs: out, duplicate: null };
}

export function HrmsConfigForm({ initial }: { initial: HrmsIntegrationDto }) {
  const { t } = useTranslation('hrms');
  const { save } = useHrmsMutations();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [preset, setPreset] = useState<HrmsPreset>(initial.preset);
  const [defaultBranchCode, setDefaultBranchCode] = useState(initial.defaultBranchCode ?? '');
  const [lists, setLists] = useState<Lists>({ employeeMapping: initial.employeeMapping, orgUnitMapping: initial.orgUnitMapping, statusMapping: initial.statusMapping, genderMapping: initial.genderMapping, employmentTypeMapping: initial.employmentTypeMapping });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touch = () => setDirty(true);
  const setList = <K extends ListKey>(key: K, value: Lists[K]) => { setLists((l) => ({ ...l, [key]: value })); touch(); };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleaned = {} as Lists;
    for (const key of Object.keys(lists) as ListKey[]) {
      const c = cleanPairs(lists[key] as ReadonlyArray<HrmsMappingPair>);
      if (c.duplicate) { setError(t('duplicateSource', { source: c.duplicate })); return; }
      (cleaned as Record<ListKey, unknown>)[key] = c.pairs;
    }
    const payload: HrmsIntegrationInput = { enabled, preset, defaultBranchCode: defaultBranchCode.trim() || null, ...cleaned };
    setSaving(true);
    try {
      await save.mutateAsync(payload);
      toast.success(t('saved'));
      setDirty(false);
    } catch (err) { toastError(err); } finally { setSaving(false); }
  };

  const loadPreset = () => { setLists(hrmsPresetPairs(preset)); touch(); toast.info(t('presetLoaded')); };
  const presetDef = HRMS_PRESET_DEFINITIONS[preset];

  return (
    <SettingsSection title={t('title')} description={t('hint')} onSubmit={(e) => void onSubmit(e)} saving={saving} dirty={dirty}>
      <SwitchRow id="hrms-enabled" label={t('enabled')} hint={t('enabledHint')} control={<Switch id="hrms-enabled" checked={enabled} onCheckedChange={(v) => { setEnabled(v); touch(); }} />} />
      <EndpointRow endpoint={initial.endpoint} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('preset')} htmlFor="hrms-preset" hint={t('presetHint')}>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={preset} onValueChange={(v) => { setPreset(v as HrmsPreset); touch(); }}>
              <SelectTrigger id="hrms-preset" aria-label={t('preset')} className="max-w-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{HRMS_PRESETS.map((p) => <SelectItem key={p} value={p}>{t(`presets.${p}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Button type="button" variant="outline" size="sm" onClick={loadPreset}>{t('loadPreset')}</Button>
          </div>
        </FormField>
        <FormField label={t('defaultBranch')} htmlFor="hrms-default-branch" hint={t('defaultBranchHint')}>
          <Input id="hrms-default-branch" dir="ltr" className="font-mono" maxLength={32} value={defaultBranchCode} onChange={(e) => { setDefaultBranchCode(e.target.value); touch(); }} />
        </FormField>
      </div>
      <MappingEditor id="employee" title={t('employeeMapping')} hint={t('mappingHint')} pairs={lists.employeeMapping} targets={HRMS_EMPLOYEE_FIELDS} labelOf={(f) => t(`fields.${f}`)} presetCount={Object.keys(presetDef.employeeMapping).length} onChange={(v) => setList('employeeMapping', v)} />
      <MappingEditor id="orgunit" title={t('orgUnitMapping')} hint={t('mappingHint')} pairs={lists.orgUnitMapping} targets={HRMS_ORG_UNIT_FIELDS} labelOf={(f) => t(`fields.${f}`)} presetCount={Object.keys(presetDef.orgUnitMapping).length} onChange={(v) => setList('orgUnitMapping', v)} />
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('valueMappings')}</summary>
        <p className="mt-1 text-xs text-muted-foreground">{t('valueMappingsHint')}</p>
        <div className="mt-3 space-y-4">
          <MappingEditor id="status" title={t('statusMapping')} pairs={lists.statusMapping} targets={EMPLOYMENT_STATUSES} values labelOf={(v) => t(`values.${v}`)} presetCount={Object.keys(presetDef.statusMapping).length} onChange={(v) => setList('statusMapping', v)} />
          <MappingEditor id="gender" title={t('genderMapping')} pairs={lists.genderMapping} targets={GENDERS} values labelOf={(v) => t(`values.${v}`)} presetCount={Object.keys(presetDef.genderMapping).length} onChange={(v) => setList('genderMapping', v)} />
          <MappingEditor id="type" title={t('employmentTypeMapping')} pairs={lists.employmentTypeMapping} targets={EMPLOYMENT_TYPES} values labelOf={(v) => t(`values.${v}`)} presetCount={Object.keys(presetDef.employmentTypeMapping).length} onChange={(v) => setList('employmentTypeMapping', v)} />
        </div>
      </details>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </SettingsSection>
  );
}

function EndpointRow({ endpoint }: { endpoint: string }) {
  const { t } = useTranslation('hrms');
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(endpoint); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the field is selectable */ } };
  return (
    <FormField label={t('endpoint')} htmlFor="hrms-endpoint" hint={t('endpointHint', { endpoint })}>
      <div className="flex items-center gap-2">
        <Input id="hrms-endpoint" readOnly dir="ltr" className="font-mono text-xs" value={endpoint} onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}><Copy /> {copied ? t('copied') : t('copy')}</Button>
      </div>
    </FormField>
  );
}

/** Editable list of HR-system name → FlowZa field (or value) pairs. Empty = the preset's list is used. */
export function MappingEditor<T extends string>({ id, title, hint, pairs, targets, labelOf, presetCount, values, onChange }: {
  id: string; title: string; hint?: string; pairs: ReadonlyArray<HrmsMappingPair<T>>; targets: readonly T[]; labelOf: (target: T) => string; presetCount: number; values?: boolean;
  onChange: (next: Array<HrmsMappingPair<T>>) => void;
}) {
  const { t } = useTranslation('hrms');
  const update = (i: number, patch: Partial<HrmsMappingPair<T>>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <fieldset className="space-y-2" aria-labelledby={`hrms-map-${id}`}>
      <legend id={`hrms-map-${id}`} className="text-sm font-semibold">{title}</legend>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {pairs.length === 0 ? <p className="text-xs text-muted-foreground">{t('usingPreset', { count: presetCount })}</p> : null}
      <ul className="space-y-2">
        {pairs.map((p, i) => (
          <li key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
            <Input aria-label={`${values ? t('sourceValue') : t('source')} ${i + 1}`} dir="auto" maxLength={64} value={p.source} onChange={(e) => update(i, { source: e.target.value })} />
            <select aria-label={`${values ? t('targetValue') : t('target')} ${i + 1}`} className={cn('h-9 px-2', fieldClass)} value={p.target} onChange={(e) => update(i, { target: e.target.value as T })}>
              {targets.map((target) => <option key={target} value={target}>{labelOf(target)}</option>)}
            </select>
            <Button type="button" variant="ghost" size="sm" aria-label={`${t('removeRow')} ${i + 1}`} onClick={() => onChange(pairs.filter((_, j) => j !== i))}><Trash2 /></Button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...pairs, { source: '', target: targets[0]! }])}><Plus /> {t('addRow')}</Button>
    </fieldset>
  );
}

/** i18next reads ':' as its namespace separator: a scope's label key spells it '_' (hrms:write → keys.scopeNames.hrms_write). */
const scopeKey = (s: ApiKeyScope) => `keys.scopeNames.${s.replace(':', '_')}`;
const keyStatusVariant = (s: ApiKeyDto['status']) => (s === 'active' ? 'success' : s === 'expired' ? 'warning' : 'neutral');

export function ApiKeysCard() {
  const { t } = useTranslation('hrms');
  const tz = useOrgTimezone();
  const keys = useApiKeys();
  const { createKey, revokeKey } = useHrmsMutations();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreatedDto | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);
  const onRevoke = () => { if (!revoking) return; revokeKey.mutate(revoking.id, { onSuccess: () => { setRevoking(null); toast.success(t('keys.revoked')); }, onError: toastError }); };
  return (
    <Card role="region" aria-label={t('keys.title')}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div><CardTitle>{t('keys.title')}</CardTitle><CardDescription>{t('keys.hint')}</CardDescription></div>
        <Button type="button" size="sm" onClick={() => setCreating(true)}><KeyRound /> {t('keys.create')}</Button>
      </CardHeader>
      <CardContent>
        {keys.isError ? <SectionError error={keys.error} onRetry={() => void keys.refetch()} /> : (keys.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{keys.isLoading ? '…' : t('keys.empty')}</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>{t('keys.name')}</TableHead><TableHead>{t('keys.prefix')}</TableHead><TableHead>{t('keys.scopes')}</TableHead><TableHead>{t('keys.status')}</TableHead><TableHead>{t('keys.lastUsed')}</TableHead><TableHead>{t('keys.expires')}</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {(keys.data ?? []).map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell><span className="font-mono text-xs" dir="ltr">{k.prefix}…</span></TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} variant="outline">{t(scopeKey(s))}</Badge>)}</div></TableCell>
                  <TableCell><Badge variant={keyStatusVariant(k.status)}>{t(`keys.statuses.${k.status}`)}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{k.lastUsedAt ? fmtRelative(k.lastUsedAt) : t('keys.never')}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{k.expiresAt ? fmtDateTime(k.expiresAt, tz) : '—'}</TableCell>
                  <TableCell className="text-end">{k.status !== 'revoked' ? <Button type="button" variant="ghost" size="sm" onClick={() => setRevoking(k)}>{t('keys.revoke')}</Button> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CreateKeyDialog open={creating} onOpenChange={setCreating} pending={createKey.isPending} onCreate={(input) => createKey.mutate(input, { onSuccess: (dto) => { setCreating(false); setCreated(dto); }, onError: toastError })} />
      <SecretDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog open={!!revoking} onOpenChange={(o) => { if (!o) setRevoking(null); }} title={t('keys.revokeTitle', { name: revoking?.name ?? '' })} description={t('keys.revokeHint')} confirmLabel={t('keys.revoke')} destructive loading={revokeKey.isPending} onConfirm={onRevoke} />
    </Card>
  );
}

function CreateKeyDialog({ open, onOpenChange, pending, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; pending: boolean; onCreate: (input: { name: string; scopes: ApiKeyScope[]; expiresInDays: number }) => void }) {
  const { t } = useTranslation('hrms');
  const { t: tc } = useTranslation();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['hrms:write', 'hrms:read']);
  const [days, setDays] = useState(String(API_KEY_DEFAULT_DAYS));
  const daysNumber = Number(days);
  const valid = name.trim().length > 0 && scopes.length > 0 && Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= API_KEY_MAX_DAYS;
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setName(''); setScopes(['hrms:write', 'hrms:read']); setDays(String(API_KEY_DEFAULT_DAYS)); } }}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{t('keys.create')}</DialogTitle><DialogDescription>{t('keys.hint')}</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) onCreate({ name: name.trim(), scopes, expiresInDays: daysNumber }); }}>
          <FormField label={t('keys.name')} htmlFor="hrms-key-name" required><Input id="hrms-key-name" maxLength={80} placeholder={t('keys.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('keys.scopes')}</legend>
            {API_KEY_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <Checkbox checked={scopes.includes(s)} onCheckedChange={(v) => setScopes((cur) => (v ? [...new Set([...cur, s])] : cur.filter((x) => x !== s)))} aria-label={t(scopeKey(s))} />
                {t(scopeKey(s))} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{s}</span>
              </label>
            ))}
          </fieldset>
          <FormField label={t('keys.expiresInDays')} htmlFor="hrms-key-days" hint={t('keys.expiresHint')}><Input id="hrms-key-days" type="number" min={1} max={API_KEY_MAX_DAYS} dir="ltr" className="tnum w-32" value={days} onChange={(e) => setDays(e.target.value)} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
            <Button type="submit" loading={pending} disabled={!valid}>{t('keys.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The one time a key's secret is shown. Closing the dialog drops it from memory; it cannot be fetched again. */
function SecretDialog({ created, onClose }: { created: ApiKeyCreatedDto | null; onClose: () => void }) {
  const { t } = useTranslation('hrms');
  const [copied, setCopied] = useState(false);
  const copy = async () => { if (!created) return; try { await navigator.clipboard.writeText(created.secret); setCopied(true); } catch { /* the field is selectable */ } };
  return (
    <Dialog open={!!created} onOpenChange={(o) => { if (!o) { setCopied(false); onClose(); } }}>
      <DialogContent size="md">
        <DialogHeader><DialogTitle>{t('keys.createdTitle')}</DialogTitle><DialogDescription>{t('keys.createdHint')}</DialogDescription></DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="hrms-key-secret">{t('keys.secret')}</Label>
          <div className="flex items-center gap-2">
            <Input id="hrms-key-secret" readOnly dir="ltr" className="font-mono text-xs" value={created?.secret ?? ''} onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}><Copy /> {copied ? t('copied') : t('copy')}</Button>
          </div>
        </div>
        <DialogFooter><Button type="button" onClick={() => { setCopied(false); onClose(); }}>{t('keys.done')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HrmsBatchesCard() {
  const { t } = useTranslation('hrms');
  const tz = useOrgTimezone();
  const q = useHrmsBatches();
  const rows = q.data ?? [];
  return (
    <Card role="region" aria-label={t('batches.title')}>
      <CardHeader><CardTitle>{t('batches.title')}</CardTitle><CardDescription>{t('batches.hint')}</CardDescription></CardHeader>
      <CardContent>
        {q.isError ? <SectionError error={q.error} onRetry={() => void q.refetch()} /> : rows.length === 0 ? <p className="text-sm text-muted-foreground">{q.isLoading ? '…' : t('batches.empty')}</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>{t('batches.received')}</TableHead><TableHead>{t('batches.kind')}</TableHead><TableHead>{t('keys.status')}</TableHead><TableHead className="text-end">{t('batches.records')}</TableHead><TableHead className="text-end">{t('batches.errors')}</TableHead><TableHead className="text-end">{t('batches.imported')}</TableHead><TableHead>{t('keys.prefix')}</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-xs">{fmtDateTime(b.createdAt, tz)}{b.reference ? <span className="block font-mono text-muted-foreground" dir="ltr">{b.reference}</span> : null}</TableCell>
                  <TableCell>{t(`batches.kinds.${b.kind}`)}</TableCell>
                  <TableCell><Badge variant={b.status === 'COMPLETED' ? 'success' : b.status === 'FAILED' ? 'danger' : 'secondary'}>{t(`batches.status.${b.status}`)}</Badge></TableCell>
                  <TableCell className="tnum text-end">{fmtNumber(b.totalRows)}</TableCell>
                  <TableCell className={cn('tnum text-end', b.errorRows > 0 && 'text-destructive')}>{fmtNumber(b.errorRows)}</TableCell>
                  <TableCell className="tnum text-end">{fmtNumber(b.importedRows)}</TableCell>
                  <TableCell><span className="font-mono text-xs" dir="ltr">{b.apiKeyPrefix ?? '—'}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
