import { Command } from 'cmdk';
import { useTranslation } from 'react-i18next';
import { Building2, Cpu, Network, User, type LucideIcon } from 'lucide-react';
import type { SearchResult, SearchResultItem } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { groupItems, type ResultGroup } from './api';

const ICONS: Record<ResultGroup, LucideIcon> = { employees: User, devices: Cpu, branches: Building2, departments: Network };

/** Grouped, keyboard-navigable results (cmdk handles arrow keys / Enter). Used by both the page and the ⌘K dialog. */
export function ResultList({ result, loading, query, onSelect }: { result: SearchResult | undefined; loading: boolean; query: string; onSelect: (item: SearchResultItem) => void }) {
  const { t } = useTranslation('search');
  const groups = groupItems(result);
  return (
    <Command.List className="max-h-[60vh] overflow-y-auto p-1">
      {query.trim().length === 0 ? <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('hint')}</p>
        : loading && !result ? <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('searching')}</p>
        : groups.length === 0 ? <Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">{t('empty', { q: query })}</Command.Empty>
        : groups.map(({ group, items }) => {
          const Icon = ICONS[group];
          return (
            <Command.Group key={group} heading={<span className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Icon className="size-3.5" /> {t(`groups.${group}`)} <span className="tnum">({items.length})</span></span>}>
              {items.map((item) => (
                <Command.Item key={`${item.type}-${item.id}`} value={`${item.type}-${item.id}`} onSelect={() => onSelect(item)} className="flex cursor-default select-none items-center gap-3 rounded-md px-2 py-2 text-sm outline-none data-[selected=true]:bg-accent">
                  <div className="min-w-0 flex-1"><p className="truncate font-medium">{item.title}</p>{item.subtitle ? <p className="truncate text-xs text-muted-foreground" dir="ltr">{item.subtitle}</p> : null}</div>
                  {item.status ? <Badge variant="outline" className="shrink-0">{item.status}</Badge> : null}
                </Command.Item>
              ))}
            </Command.Group>
          );
        })}
    </Command.List>
  );
}
