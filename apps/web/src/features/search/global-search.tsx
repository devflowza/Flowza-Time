import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Loader2, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui';
import { useDebounced } from '@/hooks/use-debounced';
import { useSearch, resultHref } from './api';
import { ResultList } from './result-list';

/**
 * ⌘K / Ctrl+K global search. Mount once in the shell (Topbar) — it manages its own open state unless controlled.
 * Results come from GET /orgs/:orgId/search (branch-scoped, permission-filtered on the server).
 */
export function GlobalSearchDialog({ open: controlledOpen, onOpenChange }: { open?: boolean; onOpenChange?: (o: boolean) => void } = {}) {
  const { t } = useTranslation('search');
  const navigate = useNavigate();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (o: boolean) => { setInternalOpen(o); onOpenChange?.(o); };
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 200);
  const results = useSearch(debounced, open);

  useEffect(() => {
    // toggles the *effective* state so a controlled parent (Topbar button) and the shortcut never drift apart
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setInternalOpen(!open); onOpenChange?.(!open); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <DialogContent size="lg" className="top-[15%] translate-y-0 gap-0 p-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t('title')}</DialogTitle>
        <Command shouldFilter={false} label={t('title')}>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder={t('placeholder')} className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            {results.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <kbd className="rounded border px-1.5 text-[10px] text-muted-foreground">Esc</kbd>}
          </div>
          <ResultList result={results.data} loading={results.isLoading} query={debounced} onSelect={(item) => { setOpen(false); setQuery(''); navigate(resultHref(item)); }} />
          {debounced.trim() ? <div className="border-t px-3 py-2 text-xs text-muted-foreground"><button type="button" className="hover:underline" onClick={() => { setOpen(false); navigate(`/search?q=${encodeURIComponent(debounced)}`); }}>{t('openFull', { q: debounced })}</button></div> : null}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
