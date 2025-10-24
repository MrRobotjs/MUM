import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import clsx from 'clsx';

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  hasError?: boolean;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  ({ className, hasError, ...props }, ref) => (
    <input
      ref={ref}
      className={clsx(
        'input input-bordered w-full',
        hasError ? 'input-error' : 'input-primary',
        className
      )}
      {...props}
    />
  )
);

TextInput.displayName = 'TextInput';

export default TextInput;
