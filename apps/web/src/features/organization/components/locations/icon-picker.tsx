import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCATION_LEVEL_ICONS, type LocationLevelIcon } from '@flowza/contracts';
import { LevelIcon } from '@/features/locations/components/level-icon';
import { LOCATIONS_NS } from '@/features/locations/locale';
import { cn } from '@/lib/utils';

/**
 * The icon of a level: one radio group (native radios — one tab stop, arrow keys move the choice in the reading direction),
 * each option the glyph with its name under it.
 */
export function IconPicker({ value, onChange, legend }: { value: LocationLevelIcon; onChange: (icon: LocationLevelIcon) => void; legend: string }) {
  const { t } = useTranslation(LOCATIONS_NS);
  const name = useId();
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium leading-none">{legend}</legend>
      <div className="grid grid-cols-4 gap-1.5 pt-1 sm:grid-cols-5">
        {LOCATION_LEVEL_ICONS.map((icon) => (
          <label
            key={icon}
            className={cn(
              'flex min-h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border bg-card px-1 py-2 text-center text-xs text-muted-foreground transition-colors hover:bg-accent',
              'has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
            )}
          >
            <input type="radio" name={name} value={icon} checked={value === icon} onChange={() => onChange(icon)} className="sr-only" />
            <LevelIcon icon={icon} className="size-5" />
            <span className="line-clamp-2 break-words leading-tight">{t(`icons.${icon}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
