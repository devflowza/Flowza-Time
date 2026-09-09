import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';

/** Frame shared by every dashboard widget: icon tile, title/subtitle, an action on the end side, then the body. */
export function WidgetCard({ title, subtitle, icon: Icon, action, className, bodyClassName, children }: { title: string; subtitle?: string; icon?: LucideIcon; action?: ReactNode; className?: string; bodyClassName?: string; children: ReactNode }) {
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <div className="flex items-start justify-between gap-3 p-5 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon ? <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-brand-700 dark:text-brand-300"><Icon className="size-4" aria-hidden /></span> : null}
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold leading-tight">{title}</h2>
            {subtitle ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className={cn('min-w-0 flex-1 px-5 pb-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

export function ViewAllLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
      {label} <ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden />
    </Link>
  );
}

/** Compact empty state for inside a widget (the page-level EmptyState is too tall for a rail card). */
export function WidgetEmpty({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-7 text-center">
      <Icon className="mb-2 size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Rows of a list widget while it loads: the same height as the rows it replaces. */
export function WidgetRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/5" /><Skeleton className="h-3 w-3/5" /></div>
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}
