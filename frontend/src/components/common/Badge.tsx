import { type CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

export interface BadgeProps {
  children: ReactNode;
  /**
   * Background color class (e.g., 'bg-plex-100', 'bg-red-100').
   * Used to derive a softly glowing outline + text color like the provided screenshot.
   */
  color?: string;
  icon?: ReactNode;
  className?: string;
  /** Enables hover styling. If undefined, it auto-enables when wrapped in a link. */
  hover?: boolean;
  /** Whether to auto-enable hover when the badge is inside a link/route element. */
  autoHoverOnLink?: boolean;
}

type BadgeStyle = CSSProperties & {
  '--badge-color'?: string;
  [key: string]: string | number | undefined;
};

const resolveColorVariable = (bgClass: string): string => {
  const shadeMatch = bgClass.match(/^bg-([\w-]+)-(\d{2,3})$/);
  if (shadeMatch) {
    return `--color-${shadeMatch[1]}-${shadeMatch[2]}`;
  }

  const opacityMatch = bgClass.match(/^bg-([\w-]+)\/\d+$/);
  if (opacityMatch) {
    return `--${opacityMatch[1]}`;
  }

  const simpleMatch = bgClass.match(/^bg-([\w-]+)$/);
  if (simpleMatch) {
    return `--color-${simpleMatch[1]}`;
  }

  return '--primary';
};

export const Badge = ({
  children,
  color = 'bg-muted',
  icon,
  className,
  hover,
  autoHoverOnLink = true,
}: BadgeProps) => {
  const cssVar = resolveColorVariable(color);
  const ref = useRef<HTMLSpanElement | null>(null);
  const [isLinkWrapper, setIsLinkWrapper] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoHoverOnLink) return;
    const parentLink = el.closest('a, [role="link"]');
    setIsLinkWrapper(Boolean(parentLink));
  }, [autoHoverOnLink]);

  const isHoverable = hover ?? (autoHoverOnLink && isLinkWrapper);

  const colorVar = `var(${cssVar}, var(--primary))`;

  const styleVars: BadgeStyle = {
    '--badge-color': colorVar,
    '--badge-bg-light': 'color-mix(in oklch, var(--badge-color) 14%, white 86%)',
    '--badge-border-light': 'color-mix(in oklch, var(--badge-color) 55%, white 20%)',
    '--badge-text-light': 'color-mix(in oklch, var(--badge-color) 75%, black 15%)',
    '--badge-bg-hover-light': 'color-mix(in oklch, var(--badge-color) 18%, white 82%)',
    '--badge-border-hover-light': 'color-mix(in oklch, var(--badge-color) 65%, white 28%)',
    '--badge-text-hover-light': 'color-mix(in oklch, var(--badge-color) 78%, black 8%)',

    '--badge-bg-dark': 'color-mix(in oklch, var(--badge-color) 22%, black 20%)',
    '--badge-border-dark': 'color-mix(in oklch, var(--badge-color) 75%, white 0%)',
    '--badge-text-dark': 'color-mix(in oklch, var(--badge-color) 70%, white 40%)',
    '--badge-bg-hover-dark': 'color-mix(in oklch, var(--badge-color) 32%, black 10%)',
    '--badge-border-hover-dark': 'color-mix(in oklch, var(--badge-color) 90%, white 14%)',
    '--badge-text-hover-dark': 'color-mix(in oklch, var(--badge-color) 80%, white 45%)',

    textShadow: '0 1px 1px rgba(0,0,0,0.2)',
  };

  const [isHovering, setIsHovering] = useState(false);
  const inlineStyle: BadgeStyle = {
    ...styleVars,
    backgroundColor: isHoverable && isHovering ? 'var(--badge-bg-hover)' : 'var(--badge-bg)',
    border: `1.5px solid ${isHoverable && isHovering ? 'var(--badge-border-hover)' : 'var(--badge-border)'}`,
    color: isHoverable && isHovering ? 'var(--badge-text-hover)' : 'var(--badge-text)',
  };

  return (
    <span
      className={clsx(
        className,
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold leading-tight',
        'transition-[border-color] duration-150 ease-out',
        'bg-transparent',
        '[--badge-bg:var(--badge-bg-light)]',
        '[--badge-border:var(--badge-border-light)]',
        '[--badge-text:var(--badge-text-light)]',
        '[--badge-bg-hover:var(--badge-bg-hover-light)]',
        '[--badge-border-hover:var(--badge-border-hover-light)]',
        '[--badge-text-hover:var(--badge-text-hover-light)]',
        'dark:[--badge-bg:var(--badge-bg-dark)]',
        'dark:[--badge-border:var(--badge-border-dark)]',
        'dark:[--badge-text:var(--badge-text-dark)]',
        'dark:[--badge-bg-hover:var(--badge-bg-hover-dark)]',
        'dark:[--badge-border-hover:var(--badge-border-hover-dark)]',
        'dark:[--badge-text-hover:var(--badge-text-hover-dark)]'
      )}
      ref={ref}
      onMouseEnter={isHoverable ? () => setIsHovering(true) : undefined}
      onMouseLeave={isHoverable ? () => setIsHovering(false) : undefined}
      style={inlineStyle}
    >
      {icon}
      {children}
    </span>
  );
};

export default Badge;
