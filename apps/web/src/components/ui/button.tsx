import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Feedback lives on the press: a button answers on pointer-down (`active:` scale), not on release, and only colour,
 * shadow and scale transition — never layout. The primary fill carries a 1px top highlight so it reads as a surface
 * catching the light rather than a flat rectangle.
 */
const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,scale,opacity] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(15_20_25/0.18)] hover:bg-brand-800',
        secondary: 'border border-border bg-muted text-secondary-foreground hover:bg-muted-strong',
        outline: 'border border-input bg-card shadow-xs hover:bg-muted hover:text-foreground',
        ghost: 'text-foreground/85 hover:bg-muted hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(15_20_25/0.18)] hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline active:scale-100',
      },
      size: { default: 'h-9 px-4 py-2', sm: 'h-8 rounded-md px-3 text-xs', lg: 'h-10 rounded-lg px-6', icon: 'size-9' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
  const classes = cn(buttonVariants({ variant, size, className }));
  if (asChild) {
    // Radix Slot accepts exactly one child: the element it merges into (e.g. <Link>). A spinner slot would be a second child
    // and make Slot throw ("Slot failed to slot onto its children"), so `loading` is not supported together with `asChild`.
    return <Slot className={classes} ref={ref} aria-busy={loading || undefined} {...props}>{children}</Slot>;
  }
  return (
    <button className={classes} ref={ref} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});
Button.displayName = 'Button';
export { buttonVariants };
