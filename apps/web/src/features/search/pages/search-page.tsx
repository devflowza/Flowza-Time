import { useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Loader2, Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, ErrorState } from '@/components/ui';
import { useDebounced } from '@/hooks/use-debounced';
import { useSearch, resultHref } from '../api';
import { ResultList } from '../result-list';

export default function SearchPage() {
  const { t } = useTranslation('search');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? '';
  const [query, setQuery] = useState(initial);
  const debounced = useDebounced(query, 250);
  const results = useSearch(debounced);
  const total = results.data ? results.data.employees.length + results.data.devices.length + results.data.branches.length + results.data.departments.length : 0;

  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <Card className="mx-auto max-w-3xl overflow-hidden">
        <Command shouldFilter={false} label={t('title')}>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            <Command.Input autoFocus value={query} onValueChange={(v) => { setQuery(v); setParams(v ? { q: v } : {}, { replace: true }); }} placeholder={t('placeholder')} className="h-12 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground" aria-label={t('title')} />
            {results.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
          </div>
          {results.isError ? <div className="p-4"><ErrorState error={results.error} onRetry={() => void results.refetch()} /></div> : (
            <>
              {debounced.trim() && results.data ? <p className="px-4 pt-3 text-xs text-muted-foreground tnum">{t('count', { count: total, q: debounced })}</p> : null}
              <ResultList result={results.data} loading={results.isLoading} query={debounced} onSelect={(item) => navigate(resultHref(item))} />
            </>
          )}
        </Command>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground">{t('shortcutHint')}</p>
    </div>
  );
}
