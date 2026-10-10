import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

export function EmptyState({ icon: Icon = Inbox, title, description, action, className }: { icon?: LucideIcon; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center', className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-card text-brand-700 shadow-sm dark:text-brand-300"><Icon className="size-[22px]" aria-hidden /></div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {description ? <p className="mt-1.5 max-w-sm text-pretty text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
