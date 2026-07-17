import type { LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Field({ label, hint, children, className, ...props }: {
  label: string;
  hint?: string;
  children: ReactNode;
} & Omit<LabelHTMLAttributes<HTMLLabelElement>, 'children'>) {
  return (
    <label className={cn('ui-field', className)} {...props}>
      <span className="ui-field__label">{label}</span>
      {children}
      {hint && <small className="ui-field__hint">{hint}</small>}
    </label>
  );
}
