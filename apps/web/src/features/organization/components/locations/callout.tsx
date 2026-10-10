import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * The notes and errors of the Locations screens. Tinted with the status tokens and written in the foreground colour, so they
 * read the same in light and dark mode whatever `dark:` resolves to.
 */

const TONES = {
  neutral: { box: 'border-border bg-muted/40', icon: 'text-muted-foreground', Icon: Info },
  warning: { box: 'border-warning/40 bg-warning/10', icon: 'text-warning', Icon: Info },
  error: { box: 'border-destructive/40 bg-destructive/10', icon: 'text-destructive', Icon: AlertTriangle },
} as const;

/** A note (neutral / warning), or an error announced to screen readers (`tone="error"` → role="alert"). */
export function Callout({ tone = 'neutral', children, className, ...rest }: { tone?: keyof typeof TONES; children: ReactNode; className?: string; 'data-testid'?: string }) {
  const { box, icon, Icon } = TONES[tone];
  return (
    <p role={tone === 'error' ? 'alert' : undefined} className={cn('flex gap-2 rounded-md border p-3 text-sm text-foreground', box, className)} data-testid={rest['data-testid']}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', icon)} aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
