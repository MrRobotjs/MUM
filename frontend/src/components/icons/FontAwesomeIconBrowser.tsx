import { useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { IconAt, IconSearch, IconSquareDashed, IconSquareFilled } from '@tabler/icons-react';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner'

type IconSetType = 'solid' | 'regular' | 'brands';
export type FontAwesomeBrowserIcon = {
  prefix: IconSetType;
  iconName: string;
  definition: IconDefinition;
  label: string;
};

const formatIconName = (name: string) =>
  name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

type StyleBadgeRenderer = (args: {
  isActive: boolean;
  label: string;
  StyleIcon: React.ComponentType<{ className?: string }>;
}) => React.ReactNode;

type FontAwesomeIconBrowserProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (icon: FontAwesomeBrowserIcon) => void;
  title?: string;
  description?: string;
  renderStyleBadge?: StyleBadgeRenderer;
};

export const FontAwesomeIconBrowser = ({
  open,
  onOpenChange,
  onSelect,
  title = 'Browse icons',
  description = 'Choose a Font Awesome style and icon.',
  renderStyleBadge,
}: FontAwesomeIconBrowserProps) => {
  const isMobile = useIsMobile();
  const [iconBrowseQuery, setIconBrowseQuery] = useState('');
  const [activeStyleFilters, setActiveStyleFilters] = useState<IconSetType[]>([]);
  const [loadedIcons, setLoadedIcons] = useState<Record<IconSetType, FontAwesomeBrowserIcon[]>>({
    solid: [],
    regular: [],
    brands: [],
  });
  const [loadingIcons, setLoadingIcons] = useState(false);
  const [iconsLoaded, setIconsLoaded] = useState(false);

  useEffect(() => {
    if (open) {
      setIconBrowseQuery('');
      setActiveStyleFilters([]);
    }
  }, [open]);

  useEffect(() => {
    if (open && !iconsLoaded && !loadingIcons) {
      const loadIcons = async () => {
        setLoadingIcons(true);
        try {
          const [solidPack, regularPack, brandsPack] = await Promise.all([
            import('@fortawesome/free-solid-svg-icons'),
            import('@fortawesome/free-regular-svg-icons'),
            import('@fortawesome/free-brands-svg-icons'),
          ]);

          const processPack = (pack: any, prefix: IconSetType): FontAwesomeBrowserIcon[] =>
            Object.keys(pack)
              .filter((key) => key !== 'fas' && key !== 'far' && key !== 'fab' && key !== 'prefix' && pack[key].iconName)
              .map((key) => ({
                prefix,
                iconName: pack[key].iconName,
                definition: pack[key],
                label: formatIconName(pack[key].iconName),
              }));

          setLoadedIcons({
            solid: processPack(solidPack, 'solid'),
            regular: processPack(regularPack, 'regular'),
            brands: processPack(brandsPack, 'brands'),
          });
          setIconsLoaded(true);
        } catch (err) {
          console.error('Failed to load icon packs:', err);
        } finally {
          setLoadingIcons(false);
        }
      };

      loadIcons();
    }
  }, [open, iconsLoaded, loadingIcons]);

  const styleOptions: { id: IconSetType; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'regular', label: 'Regular' },
    { id: 'brands', label: 'Brands' },
  ];

  const styleIcons: Record<IconSetType, React.ComponentType<{ className?: string }>> = {
    solid: IconSquareFilled,
    regular: IconSquareDashed,
    brands: IconAt,
  };

  const filteredDisplayIcons = useMemo(() => {
    const activeStyles = activeStyleFilters.length > 0
      ? activeStyleFilters
      : (styleOptions.map((style) => style.id) as IconSetType[]);
    let icons = activeStyles.flatMap((style) => loadedIcons[style] || []);

    if (iconBrowseQuery) {
      const q = iconBrowseQuery.toLowerCase();
      icons = icons.filter(
        (icon) => icon.iconName.includes(q) || icon.label.toLowerCase().includes(q)
      );
    }

    if (!iconBrowseQuery) {
      return icons.slice(0, 300);
    }

    return icons;
  }, [activeStyleFilters, loadedIcons, iconBrowseQuery, styleOptions]);

  const availableIconsCount = useMemo(() => {
    const activeStyles = activeStyleFilters.length > 0
      ? activeStyleFilters
      : (styleOptions.map((style) => style.id) as IconSetType[]);
    return activeStyles.reduce((total, style) => total + (loadedIcons[style]?.length || 0), 0);
  }, [activeStyleFilters, loadedIcons, styleOptions]);

  const handleStyleToggle = (style: IconSetType) => {
    setActiveStyleFilters((prev) => (
      prev.includes(style)
        ? prev.filter((value) => value !== style)
        : [...prev, style]
    ));
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      bodyClassName="px-0"
      contentClassName={isMobile ? 'max-w-none' : 'max-w-4xl'}
    >
      {loadingIcons ? (
        <div className="flex h-64 items-center justify-center flex-col gap-3 px-4">
          <Spinner className="size-6 text-primary" />
          <p className="text-sm text-muted-foreground">Loading full icon library...</p>
        </div>
      ) : (
        <div className={cn('flex flex-col', isMobile ? 'h-[70vh]' : 'h-[520px]')}>
          <div className={cn('border-b border-border', isMobile ? 'p-3' : 'p-3 space-y-3')}>
            <div className="relative">
              <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                placeholder={`Search ${availableIconsCount} icons...`}
                value={iconBrowseQuery}
                onChange={(e) => setIconBrowseQuery(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 pl-9 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            {!isMobile && (
              <div className="flex flex-wrap gap-2">
                {styleOptions.map((style) => {
                  const isActive = activeStyleFilters.includes(style.id);
                  const StyleIcon = styleIcons[style.id];
                  return (
                    <button
                      key={style.id}
                      type="button"
                      onClick={() => handleStyleToggle(style.id)}
                      className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary/30"
                      aria-pressed={isActive}
                    >
                      {renderStyleBadge
                        ? renderStyleBadge({ isActive, label: style.label, StyleIcon })
                        : (
                          <span className={cn(
                            'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium',
                            isActive ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground'
                          )}>
                            <StyleIcon className="text-[0.65rem]" />
                            {style.label}
                          </span>
                        )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex-1 p-3 overflow-y-auto custom-scrollbar">
            {filteredDisplayIcons.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
                <IconSearch className="size-8 mb-2 opacity-50" />
                <p className="text-sm font-medium">No icons found</p>
                <p className="text-xs opacity-70">
                  No icons match your filters and search.
                </p>
              </div>
            ) : (
              <div className={cn('grid gap-2', isMobile ? 'grid-cols-4' : 'grid-cols-6')} key={activeStyleFilters.join('-') || 'all'}>
                {filteredDisplayIcons.map((icon) => (
                  <button
                    key={`${icon.prefix}-${icon.iconName}`}
                    type="button"
                    onClick={() => onSelect(icon)}
                    className="group flex flex-col items-center justify-center gap-2 rounded-md border border-transparent p-2 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 aspect-square"
                    title={icon.label}
                  >
                    <FontAwesomeIcon icon={icon.definition} className="text-xl" />
                    <span className="text-[9px] text-center w-full truncate leading-tight opacity-70 group-hover:opacity-100">
                      {icon.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!iconBrowseQuery && filteredDisplayIcons.length < availableIconsCount && (
              <div className="p-4 text-center text-xs text-muted-foreground italic">
                Showing top 300 icons. Search to find more...
              </div>
            )}
          </div>

          {isMobile && (
            <div className="border-t border-border bg-background/95 px-4 py-3">
              <div className="grid grid-cols-3 gap-3">
                {styleOptions.map((style) => {
                  const isActive = activeStyleFilters.includes(style.id);
                  const StyleIcon = styleIcons[style.id];
                  return (
                    <button
                      key={style.id}
                      type="button"
                      onClick={() => handleStyleToggle(style.id)}
                      aria-label={`${style.label} icons`}
                      className={cn(
                        'flex items-center justify-center rounded-md border border-border p-2 text-muted-foreground transition-colors',
                        isActive
                          ? 'bg-primary/10 text-primary border-primary/30'
                          : 'hover:bg-muted hover:text-foreground'
                      )}
                    >
                      <StyleIcon className="text-sm" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </ResponsiveDialog>
  );
};

export default FontAwesomeIconBrowser;
