import { cn } from '@/lib/utils';
import { isLevelIcon, LEVEL_ICONS } from '../level-icons';

/** A level's icon (decorative: the level's name always sits next to it). An unknown key shows the generic glyph. */
export function LevelIcon({ icon, className }: { icon: string | null | undefined; className?: string }) {
  const Icon = LEVEL_ICONS[isLevelIcon(icon) ? icon : 'other'];
  return <Icon className={cn('size-4 shrink-0', className)} aria-hidden />;
}
