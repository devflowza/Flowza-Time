import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn, initials } from '@/lib/utils';

export function Avatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  return (
    <AvatarPrimitive.Root className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full bg-brand-100 text-brand-800', className)}>
      {src ? <AvatarPrimitive.Image src={src} alt={name} className="aspect-square size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center text-xs font-semibold" delayMs={src ? 300 : 0}>{initials(name) || '?'}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
