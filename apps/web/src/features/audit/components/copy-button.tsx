import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, type ButtonProps } from '@/components/ui';
import { toast } from '@/lib/toast';

/** Copies `value` to the clipboard with visual + toast feedback. Falls back gracefully when the clipboard API is unavailable. */
export function CopyButton({ value, label, size = 'icon', variant = 'ghost', className, children }: { value: string; label?: string; size?: ButtonProps['size']; variant?: ButtonProps['variant']; className?: string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t('common.copied'));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('common.error'));
    }
  };
  return (
    <Button type="button" size={size} variant={variant} className={className} onClick={copy} aria-label={label ?? t('common.copy')}>
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
      {children}
    </Button>
  );
}
