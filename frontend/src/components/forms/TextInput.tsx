import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Input } from '@/components/ui/input';

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  hasError?: boolean;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  ({ className, hasError, ...props }, ref) => (
    <Input
      ref={ref}
      className={clsx(
        hasError && 'border-destructive focus-visible:ring-destructive/50',
        className
      )}
      {...props}
    />
  )
);

TextInput.displayName = 'TextInput';

export default TextInput;
