import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Text fields share one recipe (also used by SelectTrigger and the Combobox): a hairline that darkens on hover, and on
 * focus a border in the ring colour with a soft 3px halo — visible without the hard offset ring buttons use.
 */
export const fieldClass =
  'w-full rounded-md border border-input bg-card text-sm shadow-xs transition-[color,border-color,box-shadow] duration-150 ease-out placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn('flex h-9 px-3 py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium', fieldClass, className)}
    ref={ref}
    {...props}
  />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea className={cn('flex min-h-[80px] px-3 py-2', fieldClass, className)} ref={ref} {...props} />
));
Textarea.displayName = 'Textarea';
