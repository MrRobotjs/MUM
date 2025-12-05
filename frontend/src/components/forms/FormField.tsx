import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type FormFieldProps = {
  id: string;
  label: ReactNode;
  children: ReactNode;
  description?: string;
  error?: string;
  required?: boolean;
  className?: string;
};

export const FormField = ({
  id,
  label,
  children,
  description,
  error,
  required,
  className
}: FormFieldProps) => (
  <div className={cn('form-control w-full gap-2', className)}>
    <label className="label" htmlFor={id}>
      <span className="label-text font-medium">
        {label}
        {required ? <span className="ml-1 text-red-600 dark:text-red-400">*</span> : null}
      </span>
    </label>
    {children}
    {description ? (
      <span className="text-sm text-muted-foreground">{description}</span>
    ) : null}
    {error ? <span className="text-sm text-red-600 dark:text-red-400">{error}</span> : null}
  </div>
);

export default FormField;
