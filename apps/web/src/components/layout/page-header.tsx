import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({ title, description, actions, className, breadcrumbs }: { title: string; description?: string; actions?: ReactNode; className?: string; breadcrumbs?: ReactNode }) {
  return (
    <div className={cn('mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {breadcrumbs ? <div className="mb-1.5 text-xs text-muted-foreground">{breadcrumbs}</div> : null}
        <h1 className="truncate text-[22px] font-semibold leading-tight sm:text-[26px]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-3xl text-pretty text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
