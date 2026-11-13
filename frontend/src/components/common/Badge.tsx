import { type CSSProperties, type ReactNode, isValidElement, useEffect, useRef, useState } from 'react';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { cn } from '@/lib/utils';
import { useResolvedIconDefinition } from '@/hooks/useResolvedIconDefinition';

/**
 * The one badge used across MUM. It owns every measurement: callers choose
 * only what the badge says (label, icon, colour, style) and its size, and
 * everything inside scales with that size.
 *
 * What a badge shows can be data (a role's colour, icon and style are saved
 * with the role); how it is drawn never is.
 */
export type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';
export type BadgeVariant = 'default' | 'fill' | 'outline';

export interface BadgeProps {
  /** The label. */
  children: ReactNode;
  /** Theme colour class, e.g. 'bg-blue-500' or 'bg-primary'. */
  color?: string;
  /** A hex colour (role colours), used instead of `color`. */
  hexColor?: string | null;
  /** default: tinted; fill: solid colour; outline: border only. */
  variant?: BadgeVariant | string | null;
  /** An icon definition, a ready element (such as a service icon), or nothing. */
  icon?: IconDefinition | ReactNode;
  /** A saved icon class such as 'fa-solid fa-download' (role icons). */
  iconClass?: string | null;
  /** Font size step; padding, gap, icon, border and corners follow it. */
  size?: BadgeSize;
  /** Pill for roles, rounded for everything else. */
  shape?: 'rounded' | 'pill';
  /** Longest label width before it is cut with an ellipsis, e.g. '120px'. */
  maxLabelWidth?: string;
  title?: string;
  /** Hover tint. If undefined, it turns on when the badge is inside a link. */
  hover?: boolean;
}

// Each size is a set of whole-pixel measurements. Whole pixels matter: a badge
// can sit at a fractional position (the rows above it decide), and Chrome
// draws text and icons snapped to the pixel grid. Fractional sizes would make
// the icon and the label round in different directions on different cards.
//   font / height / horizontal padding / icon / gap / border
const sizeClasses: Record<BadgeSize, string> = {
  xs: 'text-[10px] h-[20px] px-[6px] [--badge-icon:9px] [--badge-gap:4px] border',
  sm: 'text-xs h-[24px] px-[8px] [--badge-icon:11px] [--badge-gap:4px] border',
  md: 'text-sm h-[28px] px-[9px] [--badge-icon:12px] [--badge-gap:5px] border',
  lg: 'text-base h-[32px] px-[10px] [--badge-icon:14px] [--badge-gap:6px] border',
};

type BadgeStyle = CSSProperties & { [key: `--${string}`]: string | number | undefined };

const resolveVariant = (value?: string | null): BadgeVariant => (value === 'fill' || value === 'outline' ? value : 'default');

const parseHexColor = (hex?: string | null) => {
  if (!hex) return null;
  const cleaned = hex.trim();
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(cleaned)) return null;
  const value = cleaned.length === 4
    ? `${cleaned[1]}${cleaned[1]}${cleaned[2]}${cleaned[2]}${cleaned[3]}${cleaned[3]}`
    : cleaned.slice(1);
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
};

const readableTextColor = (hex?: string | null) => {
  const rgb = parseHexColor(hex);
  if (!rgb) return '#ffffff';
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255 > 0.6 ? '#111827' : '#ffffff';
};

const colorVariable = (bgClass: string): string => {
  const shade = bgClass.match(/^bg-([\w-]+)-(\d{2,3})$/);
  if (shade) return `--color-${shade[1]}-${shade[2]}`;
  const opacity = bgClass.match(/^bg-([\w-]+)\/\d+$/);
  if (opacity) return `--${opacity[1]}`;
  const simple = bgClass.match(/^bg-([\w-]+)$/);
  if (simple) return `--color-${simple[1]}`;
  return '--primary';
};

const isIconDefinition = (value: unknown): value is IconDefinition =>
  typeof value === 'object' && value !== null && !isValidElement(value) && 'iconName' in value && 'prefix' in value;

export const Badge = ({
  children,
  color = 'bg-muted',
  hexColor,
  variant,
  icon,
  iconClass,
  size = 'sm',
  shape = 'rounded',
  maxLabelWidth,
  title,
  hover,
}: BadgeProps) => {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [insideLink, setInsideLink] = useState(false);
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (hover === undefined && ref.current) setInsideLink(Boolean(ref.current.closest('a, [role="link"]')));
  }, [hover]);
  const hoverable = hover ?? insideLink;
  const hovered = hoverable && hovering;

  const resolvedIconDefinition = useResolvedIconDefinition(iconClass);
  const iconDefinition = isIconDefinition(icon) ? icon : resolvedIconDefinition;
  const iconNode = iconDefinition ? <FontAwesomeIcon icon={iconDefinition} /> : (icon as ReactNode) ?? null;

  const style = resolveVariant(variant);
  const tint = (state: string) => (hovered ? `var(--badge-${state}-hover)` : `var(--badge-${state})`);
  const inlineStyle: BadgeStyle = {
    '--badge-color': hexColor || `var(${colorVariable(color)}, var(--primary))`,
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
    backgroundColor: style === 'fill' ? 'var(--badge-color)' : style === 'outline' ? 'transparent' : tint('bg'),
    borderColor: style === 'fill' ? 'var(--badge-color)' : tint('border'),
    color: style === 'fill' ? (hexColor ? readableTextColor(hexColor) : 'var(--badge-text)') : tint('text'),
  };

  return (
    <span
      ref={ref}
      title={title}
      style={inlineStyle}
      onMouseEnter={hoverable ? () => setHovering(true) : undefined}
      onMouseLeave={hoverable ? () => setHovering(false) : undefined}
      className={cn(
        // Geometry comes from the size step.
        'inline-flex max-w-full shrink-0 items-center align-middle',
        'border-solid font-medium leading-none whitespace-nowrap',
        shape === 'pill' ? 'rounded-full' : 'rounded-[0.5em]',
        sizeClasses[size],
        // Font Awesome 7 gives every icon a 1.25em-wide box; badges use each
        // icon's own width so the gap to the label is always the same.
        '[--fa-width:auto]',
        'transition-[border-color] duration-150 ease-out',
        '[--badge-bg:var(--badge-bg-light)] [--badge-border:var(--badge-border-light)] [--badge-text:var(--badge-text-light)]',
        '[--badge-bg-hover:var(--badge-bg-hover-light)] [--badge-border-hover:var(--badge-border-hover-light)] [--badge-text-hover:var(--badge-text-hover-light)]',
        'dark:[--badge-bg:var(--badge-bg-dark)] dark:[--badge-border:var(--badge-border-dark)] dark:[--badge-text:var(--badge-text-dark)]',
        'dark:[--badge-bg-hover:var(--badge-bg-hover-dark)] dark:[--badge-border-hover:var(--badge-border-hover-dark)] dark:[--badge-text-hover:var(--badge-text-hover-dark)]'
      )}
    >
      <span
        className={cn(
          // One line, trimmed to the capital letters so the badge centres the
          // text optically (browsers without text-box centre the line box).
          'block min-w-0 [text-box:trim-both_cap_alphabetic]',
          maxLabelWidth && 'overflow-x-clip text-ellipsis [overflow-clip-margin:0.25em]'
        )}
        style={maxLabelWidth ? { maxWidth: iconNode ? `calc(${maxLabelWidth} + var(--badge-icon) + var(--badge-gap))` : maxLabelWidth } : undefined}
      >
        {iconNode && (
          // The icon sits on the text baseline, 1px below it, at a whole-pixel
          // height: it is then always drawn exactly where the text is, wherever
          // the badge lands on the pixel grid, and its centre meets the middle
          // of the capital letters at every size.
          // Font Awesome's runtime stylesheet is not in a cascade layer, so it
          // outranks utilities: its icons are sized through its own rules
          // instead (1em of the slot's font size, display block, no nudge).
          <span className="mr-[var(--badge-gap)] inline-block h-[var(--badge-icon)] overflow-hidden align-[-1px] [font-size:var(--badge-icon)] [--fa-display:block] [&>*]:block [&>*]:h-full [&_svg]:h-full [&_svg]:w-auto [&_img]:h-full [&_img]:w-auto">
            {iconNode}
          </span>
        )}
        {children}
      </span>
    </span>
  );
};

/** A user or admin role, drawn from its saved name, colour, icon and style. */
export interface RoleBadgeRole {
  name: string;
  color?: string | null;
  icon?: string | null;
  badge_style?: string | null;
  description?: string | null;
}

export const RoleBadge = ({ role, kind, size = 'sm' }: { role: RoleBadgeRole; kind: 'user' | 'admin'; size?: BadgeSize }) => (
  <Badge
    hexColor={role.color}
    color={kind === 'admin' ? 'bg-blue-500' : 'bg-secondary'}
    iconClass={role.icon}
    variant={role.badge_style}
    shape="pill"
    size={size}
    title={role.description ?? undefined}
    hover={false}
  >
    {role.name}
  </Badge>
);

export default Badge;
