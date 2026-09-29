import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { PlatformAuditEntryDto } from '@flowza/contracts';
import { cn } from '@/lib/utils';
import { fmtDateTime, fmtRelative } from '@/lib/format';

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]" dir="ltr">{JSON.stringify(value, null, 2)}</pre>;
}

/** Platform administrators' audit entries; each row expands to its before / after values and reason. */
export function ActivityList({ entries, empty, compact = false, showTenant = true }: { entries: PlatformAuditEntryDto[]; empty: string; compact?: boolean; showTenant?: boolean }) {
  const { t } = useTranslation('adm');
  const [open, setOpen] = useState<string | null>(null);
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y">
      {entries.map((e) => {
        const expanded = open === e.id;
        const expandable = !compact && (e.oldValue !== null || e.newValue !== null || !!e.reason);
        return (
          <li key={e.id} className="py-2.5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm"><span className="font-mono text-xs" dir="ltr">{e.action}</span>
                  {showTenant ? <> · {e.organizationId ? <Link to={`/adm/tenants/${e.organizationId}`} className="hover:underline">{e.organizationName ?? e.organizationId.slice(0, 8)}</Link> : <span className="text-muted-foreground">{t('activity.platform')}</span>}</> : null}
                </p>
                <p className="truncate text-xs text-muted-foreground"><span dir="ltr">{e.actorLabel ?? e.actorUserId?.slice(0, 8) ?? '—'}</span> · <span title={fmtDateTime(e.createdAt, 'UTC')} className="tnum">{compact ? fmtRelative(e.createdAt) : `${fmtDateTime(e.createdAt, 'UTC')} UTC`}</span>
                  {e.reason && !expanded ? <> · <span className="italic">{e.reason}</span></> : null}
                </p>
              </div>
              {expandable ? (
                <button type="button" onClick={() => setOpen(expanded ? null : e.id)} aria-expanded={expanded} aria-label={t('activity.details')}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
                  <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
                </button>
              ) : null}
            </div>
            {expanded ? (
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                {e.reason ? <p className="sm:col-span-2"><span className="font-medium">{t('activity.reason')}:</span> {e.reason}</p> : null}
                <div><p className="mb-1 font-medium">{t('activity.before')}</p><Json value={e.oldValue} /></div>
                <div><p className="mb-1 font-medium">{t('activity.after')}</p><Json value={e.newValue} /></div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
