import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-muted text-foreground',
      outline: 'text-foreground',
      success: 'border-transparent bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
      warning: 'border-transparent bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
      danger: 'border-transparent bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
      info: 'border-transparent bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
      neutral: 'border-transparent bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    },
  },
  defaultVariants: { variant: 'default' },
});
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> { dot?: boolean }
export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}
export { badgeVariants };
