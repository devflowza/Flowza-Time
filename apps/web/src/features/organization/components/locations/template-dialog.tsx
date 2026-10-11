import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { LOCATION_TEMPLATES, type LocationTemplate, type LocationTemplateKey } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { useLocationLevelMutations } from '@/features/locations/api';
import { LevelIcon } from '@/features/locations/components/level-icon';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { hasStructureLocations, isCurrentTemplate } from '@/features/locations/rules';
import type { LocationTree } from '@/features/locations/use-location-tree';
import { ApiError } from '@/lib/api-client';
import { useLocalName } from '@/lib/local-name';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Callout } from './callout';

/** A template's levels as a chain of chips, top first, in the UI language. */
function TemplateChain({ template }: { template: LocationTemplate }) {
  const local = useLocalName();
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {template.levels.map((l, i) => (
        // the chevron travels with the chip it points to, so a wrapped chain never ends a line on an arrow
        <span key={`${l.role}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <ChevronRight className="size-3 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden /> : null}
          <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs', l.role === 'branch' ? 'border-primary/40 bg-accent font-medium text-foreground' : 'bg-card text-muted-foreground')}>
            <LevelIcon icon={l.icon} className="size-3" />
            {local(l.name, l.nameAr)}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * "Use a template" (docs/locations.md §1, templates): pick one of LOCATION_TEMPLATES and the server replaces the level list
 * with it. Only possible while no group / place location exists — said up front, and a 409 (someone added one meanwhile)
 * is explained in place.
 */
export function TemplateDialog({ tree, onClose }: { tree: LocationTree; onClose: () => void }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const { t: tc } = useTranslation();
  const name = useId();
  const { applyTemplate } = useLocationLevelMutations();
  const current = LOCATION_TEMPLATES.find((tpl) => isCurrentTemplate(tree.levels, tpl))?.key ?? null;
  const blocked = hasStructureLocations(tree);
  const [selected, setSelected] = useState<LocationTemplateKey | null>(null);
  const [conflict, setConflict] = useState(false);

  const apply = () => {
    if (!selected) return;
    setConflict(false);
    applyTemplate.mutate({ template: selected }, {
      onSuccess: () => { toast.success(t('templates.applied', { name: t(`templates.${selected}.title`) })); onClose(); },
      onError: (e) => { if (e instanceof ApiError && e.status === 409) setConflict(true); else toastError(e); },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{t('templates.title')}</DialogTitle>
          <DialogDescription>{t('templates.description')}</DialogDescription>
        </DialogHeader>
        {blocked ? <Callout tone="warning" data-testid="template-blocked">{t('templates.blocked')}</Callout> : null}
        <fieldset>
          <legend className="sr-only">{t('templates.label')}</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LOCATION_TEMPLATES.map((tpl) => (
              <label
                key={tpl.key}
                className={cn(
                  'flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-start transition-colors hover:bg-accent/60',
                  'has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                )}
              >
                <input type="radio" name={name} value={tpl.key} checked={selected === tpl.key} onChange={() => { setSelected(tpl.key); setConflict(false); }} className="sr-only" />
                <span className="flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold">{t(`templates.${tpl.key}.title`)}</span>
                  {current === tpl.key ? <Badge variant="success">{t('templates.current')}</Badge> : null}
                </span>
                <span className="block text-xs text-muted-foreground">{t(`templates.${tpl.key}.description`)}</span>
                <TemplateChain template={tpl} />
                {tpl.standard ? <span className="block"><Badge variant="info" title={t('templates.follows', { standard: tpl.standard })}><span dir="ltr">{tpl.standard}</span></Badge></span> : null}
              </label>
            ))}
          </div>
        </fieldset>
        {conflict ? <Callout tone="error">{t('templates.conflict')}</Callout> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={apply} loading={applyTemplate.isPending} disabled={blocked || !selected || selected === current}>{t('templates.apply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
