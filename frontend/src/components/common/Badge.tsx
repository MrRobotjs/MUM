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

  const baseStyle: BadgeStyle = {
    '--badge-color': `var(${cssVar}, var(--primary))`,
    color: 'color-mix(in oklch, var(--badge-color) 70%, white 40%)',
    backgroundColor: 'color-mix(in oklch, var(--badge-color) 22%, black 20%)',
    border: '1.5px solid color-mix(in oklch, var(--badge-color) 80%, white 10%)',
    boxShadow: '0 0 2px color-mix(in oklch, var(--badge-color) 30%, transparent)',
    textShadow: '0 1px 2px rgba(0,0,0,0.35)',
  };

  const hoverStyle: BadgeStyle = isHoverable
    ? {
        backgroundColor: 'color-mix(in oklch, var(--badge-color) 32%, black 10%)',
        border: '1.5px solid color-mix(in oklch, var(--badge-color) 90%, white 18%)',
        color: 'color-mix(in oklch, var(--badge-color) 80%, white 45%)',
        boxShadow: '0 0 4px color-mix(in oklch, var(--badge-color) 35%, transparent)',
      }
    : {};

  const [isHovering, setIsHovering] = useState(false);
  const inlineStyle = isHoverable && isHovering ? { ...baseStyle, ...hoverStyle } : baseStyle;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-md px-3 py-1 text-xs font-semibold leading-tight',
        'transition-[border-color] duration-150 ease-out',
        'bg-transparent',
        className
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
