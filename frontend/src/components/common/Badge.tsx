import { type CSSProperties, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

export interface BadgeProps {
  children: ReactNode;
  /**
   * Background color class (e.g., 'bg-plex-100', 'bg-red-100').
   * Used to derive a softly glowing outline + text color like the provided screenshot.
   */
  color?: string;
  /** Hex color override for inline role badges. */
  hexColor?: string | null;
  /** Role styling shortcut for user/admin role badges. */
  roleKind?: 'user' | 'admin';
  badgeStyle?: 'default' | 'fill' | 'outline';
  icon?: ReactNode;
  iconClass?: string | null;
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** Enables hover styling. If undefined, it auto-enables when wrapped in a link. */
  hover?: boolean;
  /** Whether to auto-enable hover when the badge is inside a link/route element. */
  autoHoverOnLink?: boolean;
}

type BadgeStyle = CSSProperties & {
  '--badge-color'?: string;
  [key: string]: string | number | undefined;
};

const resolveBadgeStyle = (value?: string | null): 'default' | 'fill' | 'outline' => {
  if (value === 'fill' || value === 'outline') {
    return value;
  }
  return 'default';
};

const parseHexColor = (hex?: string | null) => {
  if (!hex) return null;
  const cleaned = hex.trim();
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(cleaned)) return null;
  const normalized = cleaned.length === 4
    ? `#${cleaned[1]}${cleaned[1]}${cleaned[2]}${cleaned[2]}${cleaned[3]}${cleaned[3]}`
    : cleaned;
  const value = normalized.slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
};

const getReadableTextColor = (hex?: string | null) => {
  const rgb = parseHexColor(hex);
  if (!rgb) return '#ffffff';
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance > 0.6 ? '#111827' : '#ffffff';
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

type IconSetType = 'solid' | 'regular' | 'brands';

const ICON_STYLE_TOKENS = new Set(['fa-solid', 'fa-regular', 'fa-brands', 'fa-light', 'fa-thin', 'fa-duotone']);
const ICON_MODIFIER_TOKENS = new Set([
  'fa-fw',
  'fa-xs',
  'fa-sm',
  'fa-lg',
  'fa-2x',
  'fa-3x',
  'fa-4x',
  'fa-5x',
  'fa-6x',
  'fa-7x',
  'fa-8x',
  'fa-9x',
  'fa-10x',
  'fa-spin',
  'fa-pulse',
  'fa-spin-pulse',
  'fa-spin-reverse',
  'fa-bounce',
  'fa-shake',
  'fa-beat',
  'fa-fade',
  'fa-flip',
  'fa-rotate-90',
  'fa-rotate-180',
  'fa-rotate-270',
  'fa-flip-horizontal',
  'fa-flip-vertical',
]);

const iconPackCache: Partial<Record<IconSetType, Map<string, IconDefinition>>> = {};
const iconPackPromiseCache: Partial<Record<IconSetType, Promise<Map<string, IconDefinition>>>> = {};
const iconDefinitionCache = new Map<string, IconDefinition>();

const parseIconClass = (iconClass?: string | null): { prefix: IconSetType; iconName: string } | null => {
  if (!iconClass) return null;
  const trimmed = iconClass.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const styleToken = tokens.find((token) => ICON_STYLE_TOKENS.has(token));
  const prefix: IconSetType = styleToken === 'fa-brands' ? 'brands' : styleToken === 'fa-regular' ? 'regular' : 'solid';

  const iconToken = tokens.find((token) => token.startsWith('fa-') && !ICON_STYLE_TOKENS.has(token) && !ICON_MODIFIER_TOKENS.has(token));
  if (!iconToken) return null;
  const iconName = iconToken.replace(/^fa-/, '');
  if (!iconName) return null;
  return { prefix, iconName };
};

const loadIconPack = async (prefix: IconSetType) => {
  if (iconPackCache[prefix]) {
    return iconPackCache[prefix]!;
  }
  if (iconPackPromiseCache[prefix]) {
    return iconPackPromiseCache[prefix]!;
  }

  const loader = async () => {
    const pack =
      prefix === 'brands'
        ? await import('@fortawesome/free-brands-svg-icons')
        : prefix === 'regular'
          ? await import('@fortawesome/free-regular-svg-icons')
          : await import('@fortawesome/free-solid-svg-icons');
    const map = new Map<string, IconDefinition>();
    Object.keys(pack).forEach((key) => {
      const value = (pack as Record<string, IconDefinition>)[key];
      if (value && (value as IconDefinition).iconName) {
        map.set(value.iconName, value);
      }
    });
    iconPackCache[prefix] = map;
    return map;
  };

  const promise = loader();
  iconPackPromiseCache[prefix] = promise;
  return promise;
};

export const Badge = ({
  children,
  color = 'bg-muted',
  hexColor,
  roleKind,
  badgeStyle,
  icon,
  iconClass,
  className,
  style,
  title,
  hover,
  autoHoverOnLink = true,
}: BadgeProps) => {
  const roleFallbackColor = roleKind === 'admin' ? 'bg-blue-500' : 'bg-secondary';
  const resolvedColor = roleKind && color === 'bg-muted' ? roleFallbackColor : color;
  const cssVar = resolveColorVariable(resolvedColor);
  const ref = useRef<HTMLSpanElement | null>(null);
  const [isLinkWrapper, setIsLinkWrapper] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoHoverOnLink) return;
    const parentLink = el.closest('a, [role="link"]');
    setIsLinkWrapper(Boolean(parentLink));
  }, [autoHoverOnLink]);

  const isHoverable = roleKind && hover === undefined
    ? false
    : (hover ?? (autoHoverOnLink && isLinkWrapper));

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

  const parsedIcon = useMemo(() => parseIconClass(iconClass), [iconClass]);
  const iconCacheKey = parsedIcon ? `${parsedIcon.prefix}:${parsedIcon.iconName}` : null;
  const [resolvedIconDef, setResolvedIconDef] = useState<IconDefinition | null>(null);

  useEffect(() => {
    if (!parsedIcon || !iconCacheKey) {
      setResolvedIconDef(null);
      return;
    }

    const cached = iconDefinitionCache.get(iconCacheKey);
    if (cached) {
      setResolvedIconDef(cached);
      return;
    }

    let cancelled = false;
    loadIconPack(parsedIcon.prefix)
      .then((pack) => {
        if (cancelled) return;
        const found = pack.get(parsedIcon.iconName) ?? null;
        if (found) {
          iconDefinitionCache.set(iconCacheKey, found);
        }
        setResolvedIconDef(found);
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedIconDef(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [parsedIcon, iconCacheKey]);

  const resolvedIcon = icon
    ?? (resolvedIconDef
      ? <FontAwesomeIcon icon={resolvedIconDef} className="text-[0.65rem]" />
      : undefined);
  const colorOverride = hexColor ? { '--badge-color': hexColor } : null;
  const [isHovering, setIsHovering] = useState(false);
  const resolvedStyle = resolveBadgeStyle(badgeStyle);
  const baseBackground = isHoverable && isHovering ? 'var(--badge-bg-hover)' : 'var(--badge-bg)';
  const baseBorder = `1.5px solid ${isHoverable && isHovering ? 'var(--badge-border-hover)' : 'var(--badge-border)'}`;
  const baseText = isHoverable && isHovering ? 'var(--badge-text-hover)' : 'var(--badge-text)';
  const fillBackground = hexColor ?? 'var(--badge-color)';
  const fillBorder = `1.5px solid ${hexColor ?? 'var(--badge-color)'}`;
  const fillText = hexColor ? getReadableTextColor(hexColor) : 'var(--badge-text)';
  const inlineStyle: BadgeStyle = {
    ...styleVars,
    ...(colorOverride ?? {}),
    ...(style ?? {}),
    backgroundColor: resolvedStyle === 'fill'
      ? fillBackground
      : resolvedStyle === 'outline'
        ? 'transparent'
        : baseBackground,
    border: resolvedStyle === 'fill'
      ? fillBorder
      : baseBorder,
    color: resolvedStyle === 'fill'
      ? fillText
      : baseText,
  };

  return (
    <span
      className={cn(
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
        'dark:[--badge-text-hover:var(--badge-text-hover-dark)]',
        className
      )}
      ref={ref}
      onMouseEnter={isHoverable ? () => setIsHovering(true) : undefined}
      onMouseLeave={isHoverable ? () => setIsHovering(false) : undefined}
      style={inlineStyle}
      title={title}
    >
      {resolvedIcon}
      {children}
    </span>
  );
};

export default Badge;
