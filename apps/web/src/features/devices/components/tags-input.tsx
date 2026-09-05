import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Input } from '@/components/ui';

/** Chip-style tag editor: Enter / comma adds, Backspace on empty input removes the last tag. */
export function TagsInput({ id, value, onChange, max = 20, disabled }: { id?: string; value: string[]; onChange: (tags: string[]) => void; max?: number; disabled?: boolean }) {
  const { t } = useTranslation('devices');
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const tag = raw.trim().slice(0, 40);
    if (!tag || value.includes(tag) || value.length >= max) return;
    onChange([...value, tag]);
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-card px-2 py-1 shadow-sm focus-within:ring-2 focus-within:ring-ring">
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 font-normal">
          {tag}
          {!disabled ? <button type="button" className="rounded-full hover:text-destructive" aria-label={t('tags.remove', { tag })} onClick={() => onChange(value.filter((x) => x !== tag))}><X className="size-3" /></button> : null}
        </Badge>
      ))}
      <Input
        id={id} value={text} disabled={disabled || value.length >= max} placeholder={value.length ? '' : t('tags.placeholder')}
        className="h-7 min-w-[120px] flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); setText(''); }
          else if (e.key === 'Backspace' && text === '' && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => { if (text.trim()) { add(text); setText(''); } }}
      />
    </div>
  );
}
