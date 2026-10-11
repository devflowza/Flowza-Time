import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from './card';
import { Skeleton } from './skeleton';

export function StatCard({ label, value, icon: Icon, tone = 'default', hint, loading, onClick }: { label: string; value: string | number; icon?: LucideIcon; tone?: 'default' | 'success' | 'warning' | 'danger' | 'info'; hint?: string; loading?: boolean; onClick?: () => void }) {
  const toneClass = { default: 'text-brand-700 bg-accent dark:text-brand-300', success: 'text-emerald-700 bg-emerald-500/10 dark:text-emerald-300', warning: 'text-amber-700 bg-amber-500/10 dark:text-amber-300', danger: 'text-red-700 bg-red-500/10 dark:text-red-300', info: 'text-blue-700 bg-blue-500/10 dark:text-blue-300' }[tone];
  return (
    <Card className={cn('flex items-center gap-4 p-4', onClick && 'cursor-pointer transition-[border-color,box-shadow,translate] duration-200 ease-out hover:-translate-y-px hover:border-brand-300 hover:shadow-md')} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
      {Icon ? <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', toneClass)}><Icon className="size-5" aria-hidden /></div> : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        {loading ? <Skeleton className="mt-1 h-7 w-16" /> : <p className="tnum text-2xl font-semibold leading-tight tracking-tight">{value}</p>}
        {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </Card>
  );
}
