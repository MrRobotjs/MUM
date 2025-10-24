import type { ButtonHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>;

const variantClassNames: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost'
};

const sizeClassNames: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: 'btn-md',
  lg: 'btn-lg'
};

export const Button = ({
  variant = 'primary',
  size = 'md',
  startIcon,
  endIcon,
  className,
  children,
  ...props
}: ButtonProps) => (
  <button
    className={clsx('btn flex items-center gap-2', variantClassNames[variant], sizeClassNames[size], className)}
    {...props}
  >
    {startIcon ? <span className="inline-flex">{startIcon}</span> : null}
    <span>{children}</span>
    {endIcon ? <span className="inline-flex">{endIcon}</span> : null}
  </button>
);

export default Button;
