import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from './label';
import { cn } from '@/lib/utils';

interface FormFieldProps { label: string; htmlFor: string; error?: string; hint?: string; required?: boolean; optional?: boolean; className?: string; children: React.ReactNode }

/** Accessible label + control + hint/error wrapper for React Hook Form fields. */
export function FormField({ label, htmlFor, error, hint, required, optional, className, children }: FormFieldProps) {
  const { t } = useTranslation();
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between">
        <Label htmlFor={htmlFor}>
          {label}
          {required ? <span className="text-destructive ms-0.5" aria-hidden>*</span> : null}
        </Label>
        {optional ? <span className="text-xs text-muted-foreground">{t('common.optional')}</span> : null}
      </div>
      {children}
      {error ? <p className="text-xs text-destructive" role="alert" id={`${htmlFor}-error`}>{error}</p> : hint ? <p className="text-xs text-muted-foreground" id={`${htmlFor}-hint`}>{hint}</p> : null}
    </div>
  );
}
