import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  hasError?: boolean;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  ({ className, hasError, ...props }, ref) => (
    <Input
      ref={ref}
      className={cn(
        hasError && 'border-destructive focus-visible:ring-destructive/50',
        className
      )}
      {...props}
    />
  )
);

TextInput.displayName = 'TextInput';

export default TextInput;
