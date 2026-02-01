import { useState, useRef, useEffect, useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faCog } from '@fortawesome/free-solid-svg-icons'
import { IconPalette, IconDeviceFloppy, IconInfoCircle, IconSearch, IconX, IconPaintFilled, IconGridDots, IconCheck } from '@tabler/icons-react'
import { UserRole } from '../../hooks/useUserRoles'
import { useAlerts, useTheme } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { getReadableTextColor, resolveCssVarHex } from '@/lib/themeColors'
import { Badge } from '@/components/common/Badge'
import { AtSign, Square, SquareDashed } from 'lucide-react'

interface UserRoleDisplayTabProps {
  role: UserRole
  onUpdate: () => Promise<void>
}

const BASE_PRESET_COLORS: Array<{ hex: string; label: string }> = [
  { hex: '#1abc9c', label: 'Teal' },
  { hex: '#2ecc71', label: 'Green' },
  { hex: '#3498db', label: 'Blue' },
  { hex: '#9b59b6', label: 'Purple' },
  { hex: '#e91e63', label: 'Pink' },
  { hex: '#f1c40f', label: 'Yellow' },
  { hex: '#e67e22', label: 'Orange' },
  { hex: '#e74c3c', label: 'Red' },
  { hex: '#95a5a6', label: 'Gray' },
  { hex: '#607d8b', label: 'Blue Gray' },
  { hex: '#11806a', label: 'Dark Teal' },
  { hex: '#1f8b4c', label: 'Dark Green' },
  { hex: '#206694', label: 'Dark Blue' },
  { hex: '#71368a', label: 'Dark Purple' },
  { hex: '#ad1457', label: 'Dark Pink' },
  { hex: '#c27c0e', label: 'Dark Yellow' },
  { hex: '#a84300', label: 'Dark Orange' },
  { hex: '#992d22', label: 'Dark Red' },
  { hex: '#979c9f', label: 'Dark Gray' },
  { hex: '#546e7a', label: 'Dark Blue Gray' },
]

// Types for our dynamic icon system
type IconSetType = 'solid' | 'regular' | 'brands';
type LoadedIcon = {
  prefix: IconSetType;
  iconName: string;
  definition: IconDefinition;
  label: string;
}

// Helper to format icon names (e.g., 'arrow-up' -> 'Arrow Up')
const formatIconName = (name: string) => {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const UserRoleDisplayTab = ({ role, onUpdate }: UserRoleDisplayTabProps) => {
  const { success, error: showError } = useAlerts()
  const { theme } = useTheme()
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const isMobile = useIsMobile()
  const themePrimaryHex = useMemo(
    () => resolveCssVarHex('--primary', '#3b82f6'),
    [theme]
  )
  const presetColors = BASE_PRESET_COLORS

  // Form State
  const [formValues, setFormValues] = useState({
    name: role.name,
    description: role.description || '',
    color: role.color || themePrimaryHex,
    icon: role.icon || '',
    badge_style: role.badge_style || 'default',
  })
  const [submitting, setSubmitting] = useState(false)
  const isDefaultColorSelected = formValues.color.toLowerCase() === themePrimaryHex.toLowerCase()

  // Icon Browser State
  const [iconBrowseOpen, setIconBrowseOpen] = useState(false)
  const [iconBrowseQuery, setIconBrowseQuery] = useState('')
  const [activeStyleFilters, setActiveStyleFilters] = useState<IconSetType[]>([])

  // Data State
  const [loadedIcons, setLoadedIcons] = useState<Record<IconSetType, LoadedIcon[]>>({ solid: [], regular: [], brands: [] })
  const [loadingIcons, setLoadingIcons] = useState(false)
  const [iconsLoaded, setIconsLoaded] = useState(false)

  // Helper to resolve the currently selected icon for preview
  const resolveCurrentIcon = () => {
    if (!formValues.icon) return null;
    const [style, name] = formValues.icon.includes(' ')
      ? formValues.icon.split(' ')
      : ['fa-solid', formValues.icon]; // default to solid if no style prefix

    // Normalize prefix
    const prefix = style === 'fa-brands' ? 'brands' : style === 'fa-regular' ? 'regular' : 'solid';
    const cleanName = name?.replace(/^fa-/, '') || '';

    // Search in loaded icons first
    const found = loadedIcons[prefix as IconSetType]?.find(i => i.iconName === cleanName);
    return found?.definition || null;
  }

  // Load icons lazily when the browser opens
  useEffect(() => {
    if (iconBrowseOpen && !iconsLoaded && !loadingIcons) {
      const loadIcons = async () => {
        setLoadingIcons(true);
        try {
          // Dynamic imports for the icon packs
          const [solidPack, regularPack, brandsPack] = await Promise.all([
            import('@fortawesome/free-solid-svg-icons'),
            import('@fortawesome/free-regular-svg-icons'),
            import('@fortawesome/free-brands-svg-icons')
          ]);

          const processPack = (pack: any, prefix: IconSetType): LoadedIcon[] => {
            return Object.keys(pack)
              .filter(key => key !== 'fas' && key !== 'far' && key !== 'fab' && key !== 'prefix' && pack[key].iconName)
              .map(key => ({
                prefix,
                iconName: pack[key].iconName,
                definition: pack[key],
                label: formatIconName(pack[key].iconName)
              }));
          };

          setLoadedIcons({
            solid: processPack(solidPack, 'solid'),
            regular: processPack(regularPack, 'regular'),
            brands: processPack(brandsPack, 'brands')
          });
          setIconsLoaded(true);
        } catch (err) {
          console.error("Failed to load icon packs:", err);
          showError("Failed to load full icon library. Some icons may be unavailable.");
        } finally {
          setLoadingIcons(false);
        }
      };

      loadIcons();
    }
  }, [iconBrowseOpen, iconsLoaded, loadingIcons, showError]);

  useEffect(() => {
    setFormValues({
      name: role.name,
      description: role.description || '',
      color: role.color || themePrimaryHex,
      icon: role.icon || '',
      badge_style: role.badge_style || 'default',
    })
  }, [role, themePrimaryHex])

  // Filter Logic
  const styleOptions: { id: IconSetType; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'regular', label: 'Regular' },
    { id: 'brands', label: 'Brands' }
  ];
  const styleIcons: Record<IconSetType, React.ComponentType<{ className?: string }>> = {
    solid: Square,
    regular: SquareDashed,
    brands: AtSign,
  };

  const filteredDisplayIcons = useMemo(() => {
    const activeStyles = activeStyleFilters.length > 0
      ? activeStyleFilters
      : (styleOptions.map((style) => style.id) as IconSetType[])
    let icons = activeStyles.flatMap((style) => loadedIcons[style] || [])

    // Filter by Search Query
    if (iconBrowseQuery) {
      const q = iconBrowseQuery.toLowerCase();
      icons = icons.filter(icon =>
        icon.iconName.includes(q) ||
        icon.label.toLowerCase().includes(q)
      );
    }

    // Limit output for performance if no search active (first load optimization)
    if (!iconBrowseQuery) {
      return icons.slice(0, 300); // Render first 300 to keep DOM light
    }

    return icons;
  }, [activeStyleFilters, loadedIcons, iconBrowseQuery, styleOptions]);

  const availableIconsCount = useMemo(() => {
    const activeStyles = activeStyleFilters.length > 0
      ? activeStyleFilters
      : (styleOptions.map((style) => style.id) as IconSetType[])
    return activeStyles.reduce((total, style) => total + (loadedIcons[style]?.length || 0), 0)
  }, [activeStyleFilters, loadedIcons, styleOptions]);

  const handleBrowseOpenChange = (nextOpen: boolean) => {
    setIconBrowseOpen(nextOpen);
    if (nextOpen) {
      setIconBrowseQuery('');
      setActiveStyleFilters([]);
    }
  };

  const handleIconSelect = (icon: LoadedIcon) => {
    const prefix = icon.prefix === 'brands' ? 'fa-brands' : icon.prefix === 'regular' ? 'fa-regular' : 'fa-solid';
    setFormValues({ ...formValues, icon: `${prefix} fa-${icon.iconName}` });
    setIconBrowseOpen(false);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)

    try {
      await requestJson(`/admin/api/v2/user-roles/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify(formValues),
      })
      success('Role updated successfully')
      await onUpdate()
    } catch (err) {
      showError(`Failed to update role: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const currentIconDef = resolveCurrentIcon();
  const badgeStyleOptions: Array<{ value: 'default' | 'fill' | 'outline'; label: string; description: string }> = [
    {
      value: 'default',
      label: 'Default',
      description: 'Soft background with a subtle border.',
    },
    {
      value: 'fill',
      label: 'Fill',
      description: 'Solid color badge with strong contrast.',
    },
    {
      value: 'outline',
      label: 'Outline',
      description: 'Border-only style with no background.',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Display Settings Overview */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
            <IconPalette className="size-5 text-primary" />
          </div>
          <div>
            <h2 className="mb-1 text-xl font-semibold">Visual Display</h2>
            <p className="text-sm text-muted-foreground">
              Customize how this role badge appears to users
            </p>
          </div>
        </div>

        <Alert variant="info">
          <IconInfoCircle />
          <AlertTitle>Cosmetic Only</AlertTitle>
          <AlertDescription>
            User roles are visual badges only and do not grant any permissions or access.
          </AlertDescription>
        </Alert>
      </div>

      {/* Settings Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                <FontAwesomeIcon icon={faCog} className="text-sm text-primary" />
              </div>
              <div>
                <CardTitle className="mb-1 text-xl font-semibold">Role Settings</CardTitle>
                <CardDescription>Update the role name, colors, and icon style.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Role Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Role Name</Label>
              <Input
                id="name"
                value={formValues.name}
                onChange={(e) => setFormValues({ ...formValues, name: e.target.value })}
                required
                placeholder="VIP Member"
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formValues.description}
                onChange={(e) => setFormValues({ ...formValues, description: e.target.value })}
                placeholder="Short description shown alongside the badge."
                rows={3}
              />
            </div>

            {/* Color Picker */}
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="color">Role Color</Label>
              </div>

              <div className="flex flex-wrap gap-3">
                {/* Default Color Box */}
                <button
                  type="button"
                  className={cn(
                    'relative flex size-16 shrink-0 items-center justify-center rounded-md border transition-all',
                    isDefaultColorSelected
                      ? 'border-transparent'
                      : 'border-transparent hover:border-border'
                  )}
                  style={{ backgroundColor: themePrimaryHex }}
                  title="Default color"
                  onClick={() => setFormValues({ ...formValues, color: themePrimaryHex })}
                >
                  {isDefaultColorSelected && (
                    <IconCheck
                      className="size-6 drop-shadow-sm"
                      style={{ color: getReadableTextColor(themePrimaryHex) }}
                    />
                  )}
                  <span className="sr-only">Default color</span>
                </button>

                {/* Custom Color Box */}
                <div
                  className={cn(
                    'relative flex size-16 shrink-0 items-center justify-center rounded-md border transition-all',
                    isDefaultColorSelected
                      ? 'border-border/60 bg-transparent'
                      : 'border-transparent shadow-sm'
                  )}
                  style={{ backgroundColor: isDefaultColorSelected ? 'transparent' : formValues.color }}
                >
                  {/* Edit Pencil Icon (using Wand to avoid new import for now, or could check if Pencil exists) */}
                  <IconPaintFilled
                    className="absolute right-1 top-1 size-4 drop-shadow-md"
                    style={{ color: getReadableTextColor(formValues.color) }}
                  />
                  <Input
                    id="color"
                    type="color"
                    value={formValues.color}
                    onChange={(e) => setFormValues({ ...formValues, color: e.target.value })}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    aria-label="Choose badge color"
                  />
                  {/* Active Indicator for Custom Color (if it's not one of the presets, or just always show outline) */}
                </div>

                {/* Divider/Separator ? Or just spacing. The image shows them grouped. */}

                {/* Preset Colors Grid */}
                <div className="grid grid-cols-10 gap-1.5 pt-0.5">
                  {presetColors.map((preset) => {
                    const isSelected = preset.hex.toLowerCase() === formValues.color.toLowerCase()
                    return (
                      <button
                        key={preset.hex}
                        type="button"
                        className={cn(
                          'relative flex size-7 items-center justify-center rounded-md transition-all',
                          isSelected ? 'scale-110 z-10' : 'hover:scale-110 hover:z-10'
                        )}
                        style={{ backgroundColor: preset.hex }}
                        title={preset.label}
                        onClick={() => setFormValues({ ...formValues, color: preset.hex })}
                      >
                        {isSelected && (
                          <IconCheck
                            className="size-4 drop-shadow-sm"
                            style={{ color: getReadableTextColor(preset.hex) }}
                          />
                        )}
                        <span className="sr-only">{preset.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Selected</span>
                <span className="font-mono uppercase">{formValues.color}</span>
              </div>
            </div>

            {/* Icon Picker */}
            <div className="space-y-2">
              <Label htmlFor="icon">Icon (FontAwesome)</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="icon"
                    ref={iconInputRef}
                    value={formValues.icon}
                    onChange={(e) => setFormValues({ ...formValues, icon: e.target.value })}
                    placeholder="e.g. fa-solid fa-crown"
                    className="pr-10 font-mono text-xs"
                  />
                  {formValues.icon && (
                    <button
                      type="button"
                      onClick={() => setFormValues({ ...formValues, icon: '' })}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <IconX className="size-4" />
                    </button>
                  )}
                </div>

                {isMobile ? (
                  <>
                    <Button
                      variant="outline"
                      className="gap-2"
                      type="button"
                      onClick={() => handleBrowseOpenChange(true)}
                    >
                      <IconGridDots className="size-4" />
                      Browse Icons
                    </Button>
                    <ResponsiveDialog
                      open={iconBrowseOpen}
                      onOpenChange={handleBrowseOpenChange}
                      title="Browse icons"
                      description="Choose a Font Awesome style and icon."
                      bodyClassName="px-0"
                      contentClassName="max-w-none"
                    >
                      {loadingIcons ? (
                        <div className="flex h-64 items-center justify-center flex-col gap-3 px-4">
                          <div className="inline-flex size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          <p className="text-sm text-muted-foreground">Loading full icon library...</p>
                        </div>
                      ) : (
                        <div className="flex h-[70vh] flex-col">
                          <div className="border-b border-border p-3">
                            <div className="relative">
                              <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                              <Input
                                placeholder={`Search ${availableIconsCount} icons...`}
                                value={iconBrowseQuery}
                                onChange={(e) => setIconBrowseQuery(e.target.value)}
                                className="h-9 pl-9 text-xs"
                              />
                            </div>
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
                              <div className="grid grid-cols-4 gap-2" key={activeStyleFilters.join('-') || 'all'}>
                                {filteredDisplayIcons.map((icon) => (
                                  <button
                                    key={`${icon.prefix}-${icon.iconName}`}
                                    type="button"
                                    onClick={() => handleIconSelect(icon)}
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

                          <div className="border-t border-border bg-background/95 px-4 py-3">
                            <div className="grid grid-cols-3 gap-3">
                              {styleOptions.map(style => {
                                const isActive = activeStyleFilters.includes(style.id)
                                const StyleIcon = styleIcons[style.id]
                                return (
                                  <button
                                    key={style.id}
                                    type="button"
                                    onClick={() => {
                                      setActiveStyleFilters((prev) => (
                                        prev.includes(style.id)
                                          ? prev.filter((value) => value !== style.id)
                                          : [...prev, style.id]
                                      ))
                                    }}
                                    aria-label={`${style.label} icons`}
                                    className={cn(
                                      "flex items-center justify-center rounded-md border border-border p-2 text-muted-foreground transition-colors",
                                      isActive
                                        ? "bg-primary/10 text-primary border-primary/30"
                                        : "hover:bg-muted hover:text-foreground"
                                    )}
                                  >
                                    <StyleIcon className="text-sm" />
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </ResponsiveDialog>
                  </>
                ) : (
                  <>
                    <Button variant="outline" className="gap-2" type="button" onClick={() => handleBrowseOpenChange(true)}>
                      <IconGridDots className="size-4" />
                      Browse Icons
                    </Button>
                    <ResponsiveDialog
                      open={iconBrowseOpen}
                      onOpenChange={handleBrowseOpenChange}
                      title="Browse icons"
                      description="Choose a Font Awesome style and icon."
                      bodyClassName="px-0"
                      contentClassName="max-w-4xl"
                    >
                      {loadingIcons ? (
                        <div className="flex h-64 items-center justify-center flex-col gap-3 px-4">
                          <div className="inline-flex size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          <p className="text-sm text-muted-foreground">Loading full icon library...</p>
                        </div>
                      ) : (
                        <div className="flex h-[520px] flex-col">
                          <div className="p-3 border-b border-border space-y-3">
                            <div className="relative">
                              <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                              <Input
                                placeholder={`Search ${availableIconsCount} icons...`}
                                value={iconBrowseQuery}
                                onChange={(e) => setIconBrowseQuery(e.target.value)}
                                className="h-9 pl-9 text-xs"
                              />
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {styleOptions.map((style) => {
                                const isActive = activeStyleFilters.includes(style.id)
                                const StyleIcon = styleIcons[style.id]
                                return (
                                  <button
                                    key={style.id}
                                    type="button"
                                    onClick={() => {
                                      setActiveStyleFilters((prev) => (
                                        prev.includes(style.id)
                                          ? prev.filter((value) => value !== style.id)
                                          : [...prev, style.id]
                                      ))
                                    }}
                                    className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary/30"
                                    aria-pressed={isActive}
                                  >
                                    <Badge
                                      color={isActive ? 'bg-primary' : 'bg-muted/60'}
                                      className={cn(
                                        "rounded-full px-3 py-1 text-xs font-medium gap-1",
                                        isActive ? "text-primary-foreground" : "text-muted-foreground"
                                      )}
                                      hover={false}
                                    >
                                      <StyleIcon className="text-[0.65rem]" />
                                      {style.label}
                                    </Badge>
                                  </button>
                                )
                              })}
                            </div>
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
                              <div className="grid grid-cols-6 gap-2" key={activeStyleFilters.join('-') || 'all'}>
                                {filteredDisplayIcons.map((icon) => (
                                  <button
                                    key={`${icon.prefix}-${icon.iconName}`}
                                    type="button"
                                    onClick={() => handleIconSelect(icon)}
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
                        </div>
                      )}
                    </ResponsiveDialog>
                  </>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Search and select an icon from the FontAwesome library.
              </p>
            </div>

            {/* Badge Style */}
            <div className="space-y-3">
              <Label>Badge Style</Label>
              <div className="grid gap-3 sm:grid-cols-3">
                {badgeStyleOptions.map((option) => {
                  const isSelected = formValues.badge_style === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setFormValues({ ...formValues, badge_style: option.value })}
                      aria-pressed={isSelected}
                      className={cn(
                        'flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition',
                        isSelected
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-border bg-muted/30 hover:border-border/60'
                      )}
                    >
                      <Badge
                        hexColor={formValues.color}
                        icon={
                          currentIconDef
                            ? <FontAwesomeIcon icon={currentIconDef} className="text-[0.65rem]" />
                            : undefined
                        }
                        iconClass={!currentIconDef ? formValues.icon || null : null}
                        roleKind="user"
                        badgeStyle={option.value}
                        className="rounded-full px-3 py-1 text-xs"
                      >
                        {formValues.name || 'Role Name'}
                      </Badge>
                      <div>
                        <div className="text-xs font-semibold text-foreground">{option.label}</div>
                        <div className="text-[10px] text-muted-foreground">{option.description}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

          </CardContent>
        </Card>

        {/* Save Button */}
        <div className="flex items-center justify-end gap-3">
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <span className="mr-2 inline-flex size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />
                Saving...
              </>
            ) : (
              <>
                <IconDeviceFloppy className="mr-2 size-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
