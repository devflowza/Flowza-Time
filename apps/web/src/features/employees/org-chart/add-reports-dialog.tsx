import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { Badge, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input } from '@/components/ui';
import { todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeOptions } from '../api';
import { loadedOrgChartNodes, managersAbove } from './api';
import { LEFT_EMPLOYMENT, useAssignManager } from './use-assign-manager';
import type { PersonRef } from './context';

/**
 * "Add direct reports…" on a card or an Unassigned row: search employees, tick the ones who should report to this manager
 * (chips keep the choice while the search moves on), pick the effective date — one `assign_manager` for all of them. The
 * managers above this one on the chart cannot join the team (the line would go round in a circle): they are locked.
 */
export function AddReportsDialog({ manager, onClose }: { manager: PersonRef; onClose: () => void }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const { assign, isPending } = useAssignManager();
  const people = useEmployeeOptions();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [effectiveFrom, setEffectiveFrom] = useState(() => todayIso(tz));
  // the chain above the manager, as the chart shows it when the dialog opens (the API checks every line, dotted ones too)
  const qc = useQueryClient();
  const orgId = useOrgId();
  const [above] = useState(() => new Set(managersAbove(loadedOrgChartNodes(qc, orgId), manager.id)));
  // the manager themself is not a candidate, nor anybody who left
  const candidates = people.data.filter((e) => e.id !== manager.id && !LEFT_EMPLOYMENT.includes(e.employmentStatus));

  const toggle = (id: string, name: string, on: boolean) => setChosen((prev) => {
    const next = new Map(prev);
    if (on) next.set(id, name); else next.delete(id);
    return next;
  });
  const submit = () => {
    if (chosen.size === 0) return;
    assign({ employeeIds: [...chosen.keys()], managerEmployeeId: manager.id, line: 'primary', ...(effectiveFrom ? { effectiveFrom } : {}) }, onClose);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('orgChart.addReports.title', { name: manager.name })}</DialogTitle>
          <DialogDescription>{t('orgChart.addReports.hint', { name: manager.name })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="relative">
              <Input type="search" value={query} onChange={(e) => { setQuery(e.target.value); people.setSearch(e.target.value); }} placeholder={t('orgChart.addReports.searchPlaceholder')} aria-label={t('orgChart.addReports.search')} maxLength={100} />
              {people.isLoading ? <Loader2 className="absolute end-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden /> : null}
            </div>
            <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border p-1" aria-label={t('orgChart.addReports.results')}>
              {candidates.length === 0 && !people.isLoading ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">{tc('common.noResults')}</li> : null}
              {candidates.map((e) => {
                const already = e.managerEmployeeId === manager.id;
                const isAbove = above.has(e.id);
                const locked = already || isAbove;
                const id = `add-report-${e.id}`;
                return (
                  <li key={e.id} className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5', !locked && 'hover:bg-muted/60')}>
                    <Checkbox id={id} checked={already || (!isAbove && chosen.has(e.id))} disabled={locked} onCheckedChange={(v) => toggle(e.id, e.displayName, v === true)} />
                    <label htmlFor={id} className={cn('flex min-w-0 flex-1 cursor-pointer items-baseline justify-between gap-3 text-sm', locked && 'cursor-default opacity-70')}>
                      <span className="min-w-0 truncate"><span className="font-medium">{e.displayName}</span> <span className="font-mono text-xs text-muted-foreground" dir="ltr">{e.employeeNumber}</span></span>
                      <span className="shrink-0 truncate text-xs text-muted-foreground">
                        {already ? t('orgChart.addReports.already') : isAbove ? t('orgChart.addReports.above', { name: manager.name }) : e.managerName ? t('orgChart.addReports.reportsTo', { name: e.managerName }) : t('orgChart.addReports.noManager')}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">{t('orgChart.addReports.chosen', { count: chosen.size })}</p>
            {chosen.size === 0 ? <p className="text-xs text-muted-foreground">{t('orgChart.addReports.noneChosen')}</p> : (
              <ul className="flex flex-wrap gap-1.5">
                {[...chosen].map(([id, name]) => (
                  <li key={id}>
                    <Badge variant="secondary" className="gap-1 font-normal">
                      {name}
                      <button type="button" className="rounded-full hover:text-destructive" aria-label={t('orgChart.addReports.unchoose', { name })} onClick={() => toggle(id, name, false)}><X className="size-3" /></button>
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <FormField label={t('effective.effectiveFrom')} htmlFor="add-reports-from" hint={t('assignManager.effectiveHint')}>
            <Input id="add-reports-from" type="date" dir="ltr" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="sm:max-w-56" />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" loading={isPending} disabled={chosen.size === 0} onClick={submit}>{t('orgChart.addReports.submit', { count: chosen.size })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
