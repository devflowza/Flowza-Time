import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui';
import { useDebounced } from '@/hooks/use-debounced';

/**
 * Debounced search box bound to a URL filter (`useServerTable().setFilter`).
 * Local text is the source of truth while typing; when the bound value changes from outside (e.g. "clear filters"),
 * the text is re-synchronised.
 */
export function SearchBox({ value, onChange, placeholder, id = 'search', className }: { value: string | undefined; onChange: (v: string | undefined) => void; placeholder?: string; id?: string; className?: string }) {
  const { t } = useTranslation();
  const normalized = value || undefined;
  const [text, setText] = useState(normalized ?? '');
  const [seen, setSeen] = useState(normalized);
  const lastEmitted = useRef(normalized);
  if (seen !== normalized) {
    // external change (URL edited, filters cleared): adopt it
    setSeen(normalized);
    if (normalized !== lastEmitted.current) { setText(normalized ?? ''); lastEmitted.current = normalized; }
  }
  const debounced = useDebounced(text, 300);
  useEffect(() => {
    const next = debounced.trim() || undefined;
    if (next !== lastEmitted.current) { lastEmitted.current = next; onChange(next); }
  }, [debounced, onChange]);
  return (
    <div className={className ?? 'relative w-full sm:w-64'}>
      <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input id={id} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder ?? t('common.searchPlaceholder')} className="h-8 ps-8" aria-label={placeholder ?? t('common.search')} />
    </div>
  );
}
