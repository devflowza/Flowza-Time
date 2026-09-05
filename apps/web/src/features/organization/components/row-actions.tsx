import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui';

export interface RowAction { key: string; label: string; onSelect: () => void; destructive?: boolean; disabled?: boolean; icon?: React.ReactNode }

/** Kebab menu for table rows; stops click propagation so it never triggers onRowClick. */
export function RowActions({ actions, label }: { actions: RowAction[]; label?: string }) {
  const { t } = useTranslation();
  if (actions.length === 0) return null;
  const main = actions.filter((a) => !a.destructive);
  const danger = actions.filter((a) => a.destructive);
  return (
    <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={label ?? t('common.actions')}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {main.map((a) => <DropdownMenuItem key={a.key} disabled={a.disabled} onSelect={a.onSelect}>{a.icon}{a.label}</DropdownMenuItem>)}
          {main.length > 0 && danger.length > 0 ? <DropdownMenuSeparator /> : null}
          {danger.map((a) => <DropdownMenuItem key={a.key} destructive disabled={a.disabled} onSelect={a.onSelect}>{a.icon}{a.label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
