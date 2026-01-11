const clampChannel = (value: number) => Math.max(0, Math.min(255, value));

const parseRgbChannel = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) {
    return Math.round((parseFloat(trimmed) / 100) * 255);
  }
  return Math.round(parseFloat(trimmed));
};

const rgbStringToHex = (value: string) => {
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const toHex = (channel: string) => {
    const parsed = parseRgbChannel(channel);
    if (Number.isNaN(parsed)) return null;
    return clampChannel(parsed).toString(16).padStart(2, '0');
  };
  const r = toHex(parts[0]);
  const g = toHex(parts[1]);
  const b = toHex(parts[2]);
  if (!r || !g || !b) return null;
  return `#${r}${g}${b}`;
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

export const getReadableTextColor = (hex?: string | null) => {
  const rgb = parseHexColor(hex);
  if (!rgb) return '#ffffff';
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance > 0.6 ? '#111827' : '#ffffff';
};

export const resolveCssVarHex = (varName: string, fallback: string) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback;
  }
  const cssValue = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!cssValue || !document.body) return fallback;
  const swatch = document.createElement('span');
  swatch.style.color = cssValue;
  swatch.style.position = 'absolute';
  swatch.style.opacity = '0';
  swatch.style.pointerEvents = 'none';
  document.body.appendChild(swatch);
  const computedColor = getComputedStyle(swatch).color;
  swatch.remove();
  return rgbStringToHex(computedColor) ?? fallback;
};
