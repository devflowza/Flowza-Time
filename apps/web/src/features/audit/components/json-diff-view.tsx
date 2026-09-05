import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { changedKeys, diffLines, type Json } from '../json-diff';
import { CopyButton } from './copy-button';

/** Side-by-side old/new JSON (LTR, monospace), changed top-level keys highlighted. Stacks on narrow screens. */
export function JsonDiffView({ oldValue, newValue }: { oldValue: Json; newValue: Json }) {
  const { t } = useTranslation('audit');
  const changed = useMemo(() => changedKeys(oldValue, newValue), [oldValue, newValue]);
  const left = useMemo(() => diffLines(oldValue, changed), [oldValue, changed]);
  const right = useMemo(() => diffLines(newValue, changed), [newValue, changed]);
  if (left.length === 0 && right.length === 0) return <p className="text-sm text-muted-foreground">{t('detail.noPayload')}</p>;
  return (
    <div className="grid gap-3 md:grid-cols-2" dir="ltr">
      <Pane title={t('detail.oldValue')} lines={left} tone="old" raw={oldValue} />
      <Pane title={t('detail.newValue')} lines={right} tone="new" raw={newValue} />
    </div>
  );
}

function Pane({ title, lines, tone, raw }: { title: string; lines: { text: string; changed: boolean }[]; tone: 'old' | 'new'; raw: Json }) {
  const { t } = useTranslation('audit');
  return (
    <section className="min-w-0 overflow-hidden rounded-md border bg-muted/30">
      <header className="flex items-center justify-between border-b px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}{lines.length > 0 ? <CopyButton value={lines.map((l) => l.text).join('\n')} size="sm" label={t('detail.copyJson')} /> : null}</header>
      {lines.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{raw === null || raw === undefined ? t('detail.empty') : '—'}</p> : (
        <pre className="max-h-[50vh] overflow-auto p-3 font-mono text-xs leading-5" aria-label={title}>
          {lines.map((l, i) => <div key={i} className={cn('-mx-3 px-3', l.changed && (tone === 'old' ? 'bg-red-100/70 dark:bg-red-950/50' : 'bg-emerald-100/70 dark:bg-emerald-950/50'))}>{l.text || ' '}</div>)}
        </pre>
      )}
    </section>
  );
}
