export type CapabilityPayload = Record<string, unknown> | string[] | null | undefined;

export const normalizeCapabilityToken = (value: string) =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replaceAll(' ', '_')
    .replaceAll('-', '_');

export const flattenCapabilities = (raw: unknown): string[] => {
  const keys: string[] = [];
  const seen = new Set<string>();

  const addKey = (key: string) => {
    const normalized = normalizeCapabilityToken(key);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    keys.push(normalized);
  };

  const walk = (value: unknown, prefix?: string) => {
    if (value == null) return;

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === 'string') {
          addKey(prefix ? `${prefix}.${item}` : item);
        } else if (item && typeof item === 'object') {
          walk(item, prefix);
        }
      });
      return;
    }

    if (typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).forEach(([rawKey, child]) => {
        const key = normalizeCapabilityToken(rawKey);
        const dotted = prefix ? `${prefix}.${key}` : key;

        if (typeof child === 'boolean') {
          if (child) addKey(dotted);
          return;
        }

        if (Array.isArray(child)) {
          walk(child, dotted);
          return;
        }

        if (child && typeof child === 'object') {
          const maybeSupported = (child as Record<string, unknown>).supported;
          if (typeof maybeSupported === 'boolean' && maybeSupported) {
            addKey(dotted);
          }
          Object.entries(child as Record<string, unknown>).forEach(([nestedKey, nestedValue]) => {
            if (nestedKey === 'supported') return;
            walk({ [nestedKey]: nestedValue }, dotted);
          });
          return;
        }

        if (child) {
          addKey(dotted);
        }
      });
      return;
    }

    if (typeof value === 'string') {
      addKey(prefix ? `${prefix}.${value}` : value);
    }
  };

  walk(raw);
  return keys;
};

export const hasCapabilityToken = (
  capabilityKeys: string[] | null | undefined,
  token: string
): boolean => {
  const normalizedToken = normalizeCapabilityToken(token);
  if (!normalizedToken || !capabilityKeys || capabilityKeys.length === 0) {
    return false;
  }

  const prefix = `${normalizedToken}.`;
  return capabilityKeys.some((key) => key === normalizedToken || key.startsWith(prefix));
};

