import { useEffect, useMemo, useState } from 'react';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

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

const keyToAliasName = (key: string) => {
  if (!key.startsWith('fa') || key.length <= 2) return null;
  const body = key.slice(2);
  if (!body) return null;
  return body
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
};

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
        const aliasName = keyToAliasName(key);
        if (aliasName) {
          map.set(aliasName, value);
        }
      }
    });

    iconPackCache[prefix] = map;
    return map;
  };

  const promise = loader();
  iconPackPromiseCache[prefix] = promise;
  return promise;
};

export const useResolvedIconDefinition = (iconClass?: string | null) => {
  const [definition, setDefinition] = useState<IconDefinition | null>(null);
  const parsed = useMemo(() => parseIconClass(iconClass), [iconClass]);
  const cacheKey = parsed ? `${parsed.prefix}:${parsed.iconName}` : null;

  useEffect(() => {
    if (!parsed || !cacheKey) {
      setDefinition(null);
      return;
    }

    const cached = iconDefinitionCache.get(cacheKey);
    if (cached) {
      setDefinition(cached);
      return;
    }

    let cancelled = false;
    loadIconPack(parsed.prefix)
      .then((pack) => {
        if (cancelled) return;
        const found = pack.get(parsed.iconName) ?? null;
        if (found) {
          iconDefinitionCache.set(cacheKey, found);
        }
        setDefinition(found);
      })
      .catch(() => {
        if (!cancelled) {
          setDefinition(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [parsed, cacheKey]);

  return definition;
};

export default useResolvedIconDefinition;
