import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ArrowRight, Quote } from 'lucide-react';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import { quoteIndex } from '../model';

/** Headline card in the tenant's gradient with a link to reports (or attendance for members without report access). */
export function HighlightCard({ to, className }: { to: string; className?: string }) {
  const { t } = useTranslation('dashboard');
  return (
    <div className={cn('hero-gradient relative overflow-hidden rounded-lg p-5 text-white shadow-card', className)}>
      <svg className="pointer-events-none absolute -end-8 -top-10 size-44 opacity-20" viewBox="0 0 100 100" aria-hidden><circle cx="50" cy="50" r="50" fill="white" /></svg>
      <svg className="pointer-events-none absolute -bottom-12 start-1/3 size-36 opacity-10" viewBox="0 0 100 100" aria-hidden><circle cx="50" cy="50" r="50" fill="white" /></svg>
      <p className="relative text-lg font-semibold leading-snug">{t('highlight.title')}</p>
      <p className="relative mt-1 text-sm text-white/85">{t('highlight.body')}</p>
      <Link to={to} className="relative mt-4 inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-brand-800 shadow-sm transition-colors hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white">
        {t('highlight.cta')} <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
      </Link>
    </div>
  );
}

/** One quote a day, the same for everyone in the organisation. */
export function QuoteCard({ date, className }: { date: string; className?: string }) {
  const { t } = useTranslation('dashboard');
  const items = t('quote.items', { returnObjects: true });
  const list = Array.isArray(items) ? (items as { text: string; by: string }[]) : [];
  const q = list[quoteIndex(date, list.length)];
  if (!q) return null;
  return (
    <Card className={cn('relative overflow-hidden bg-accent p-5', className)}>
      <Quote className="absolute -end-2 -top-2 size-16 text-brand-700/10 dark:text-brand-300/10 rtl:-scale-x-100" aria-hidden />
      <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand-700 dark:text-brand-300">{t('quote.label')}</p>
      <blockquote className="relative mt-2">
        <p className="text-sm font-medium leading-relaxed">“{q.text}”</p>
        <footer className="mt-2 text-xs text-muted-foreground">— {q.by}</footer>
      </blockquote>
    </Card>
  );
}
