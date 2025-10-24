import type { ReactNode } from 'react';
import clsx from 'clsx';

type FormFieldProps = {
  id: string;
  label: string;
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
  <div className={clsx('form-control w-full gap-2', className)}>
    <label className="label" htmlFor={id}>
      <span className="label-text font-medium">
        {label}
        {required ? <span className="ml-1 text-error">*</span> : null}
      </span>
    </label>
    {children}
    {description ? (
      <span className="text-sm text-base-content/70">{description}</span>
    ) : null}
    {error ? <span className="text-sm text-error">{error}</span> : null}
  </div>
);

export default FormField;
