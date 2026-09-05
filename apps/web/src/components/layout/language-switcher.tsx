import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui';
import { SUPPORTED_LOCALES } from '@/lib/i18n';

const NAMES: Record<string, string> = { en: 'English', ar: 'العربية' };

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('common.language')}><Languages /> {NAMES[i18n.language] ?? i18n.language}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SUPPORTED_LOCALES.map((l) => <DropdownMenuItem key={l} onSelect={() => void i18n.changeLanguage(l)}>{NAMES[l]}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
