import { useState, useRef, useEffect, useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faStar as faStarSolid } from '@fortawesome/free-solid-svg-icons'
import { faStar as faStarRegular } from '@fortawesome/free-regular-svg-icons'
import { faDiscord } from '@fortawesome/free-brands-svg-icons'
import { IconPalette, IconDeviceFloppy, IconInfoCircle, IconSearch, IconX, IconCategory, IconGridDots } from '@tabler/icons-react'
import { UserRole } from '../../hooks/useUserRoles'
import { useAlerts } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/common/Badge'

interface UserRoleDisplayTabProps {
  role: UserRole
  onUpdate: () => Promise<void>
}

const presetColors: Array<{ hex: string; label: string }> = [
  { hex: '#f04747', label: 'Red' },
  { hex: '#faa61a', label: 'Orange' },
  { hex: '#fee75c', label: 'Yellow' },
  { hex: '#57f287', label: 'Green' },
  { hex: '#5865f2', label: 'Blurple' },
  { hex: '#eb459e', label: 'Pink' },
  { hex: '#9c84ef', label: 'Purple' },
  { hex: '#808080', label: 'Gray' },
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
  const iconInputRef = useRef<HTMLInputElement | null>(null)

  // Form State
  const [formValues, setFormValues] = useState({
    name: role.name,
    description: role.description || '',
    color: role.color || '#3b82f6',
    icon: role.icon || '',
  })
  const [submitting, setSubmitting] = useState(false)

  // Icon Browser State
  const [iconBrowseOpen, setIconBrowseOpen] = useState(false)
  const [iconBrowseQuery, setIconBrowseQuery] = useState('')
  const [activeTab, setActiveTab] = useState<IconSetType>('solid')

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

  // Load icons lazily when the popover opens
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

  // Filter Logic
  const filteredDisplayIcons = useMemo(() => {
    let icons = loadedIcons[activeTab] || [];

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
  }, [loadedIcons, activeTab, iconBrowseQuery]);

  const styleOptions: { id: IconSetType; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'regular', label: 'Regular' },
    { id: 'brands', label: 'Brands' }
  ];
  const styleIcons: Record<IconSetType, IconDefinition> = {
    solid: faStarSolid,
    regular: faStarRegular,
    brands: faDiscord,
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
                <i className="fa-solid fa-cog text-sm text-primary" />
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
              <Label htmlFor="color">Color</Label>
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4">
                    <span
                      className="flex size-12 items-center justify-center rounded-full border border-white/40 shadow"
                      style={{ backgroundColor: formValues.color }}
                    >
                      <IconCategory className="h-6 w-6 text-white/80 drop-shadow" />
                    </span>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <IconPalette className="h-4 w-4" />
                        Selected Color
                      </div>
                      <p className="font-mono text-xs uppercase text-muted-foreground">
                        {formValues.color}
                      </p>
                    </div>
                  </div>
                  <Input
                    id="color"
                    type="color"
                    value={formValues.color}
                    onChange={(e) => setFormValues({ ...formValues, color: e.target.value })}
                    className="h-12 w-20 cursor-pointer rounded-md border border-border bg-background p-1 shadow-sm sm:h-10"
                    aria-label="Custom color picker"
                  />
                </div>

                <div className="mt-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    Preset colors
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {presetColors.map((preset) => {
                      const isSelected = preset.hex.toLowerCase() === formValues.color.toLowerCase()
                      return (
                        <button
                          key={preset.hex}
                          type="button"
                          className={cn(
                            'flex size-9 items-center justify-center rounded-full border-2 transition',
                            isSelected
                              ? 'border-primary ring-2 ring-primary/40'
                              : 'border-transparent hover:border-border'
                          )}
                          style={{ backgroundColor: preset.hex }}
                          title={preset.label}
                          onClick={() => setFormValues({ ...formValues, color: preset.hex })}
                        >
                          <span className="sr-only">{preset.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
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

                <Popover open={iconBrowseOpen} onOpenChange={setIconBrowseOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="gap-2">
                      <IconGridDots className="size-4" />
                      Browse Icons
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[600px] p-0" align="end" side="top">
                    {loadingIcons ? (
                      <div className="flex h-64 items-center justify-center flex-col gap-3">
                        <div className="inline-flex size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        <p className="text-sm text-muted-foreground">Loading full icon library...</p>
                      </div>
                    ) : (
                      <div className="flex h-[500px]">
                        {/* Sidebar */}
                        <div className="w-48 border-r border-border bg-muted/20">
                          <div className="p-3 border-b border-border">
                            <h4 className="text-xs font-semibold uppercase text-muted-foreground">Styles</h4>
                          </div>
                          <div className="h-[calc(100%-45px)] overflow-y-auto custom-scrollbar">
                            <div className="p-2 space-y-1">
                              {styleOptions.map(style => {
                                // exact count for this style
                                const count = loadedIcons[style.id]?.length || 0;

                                return (
                                  <button
                                    key={style.id}
                                    type="button"
                                    onClick={() => {
                                      setActiveTab(style.id);
                                      setIconBrowseQuery(''); // Clear search on tab switch
                                    }}
                                    className={cn(
                                      "w-full text-left px-2 py-2 rounded-md text-xs transition-colors flex justify-between items-center group/cat",
                                      activeTab === style.id
                                        ? "bg-primary/10 text-primary font-medium"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                    )}
                                  >
                                    <span className="flex items-center gap-2">
                                      <FontAwesomeIcon icon={styleIcons[style.id]} className="text-xs" />
                                      {style.label}
                                    </span>
                                    <span className={cn(
                                      "text-[10px] opacity-70",
                                      activeTab === style.id
                                        ? "text-primary/70"
                                        : "text-muted-foreground group-hover/cat:text-foreground"
                                    )}>
                                      {count}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>

                        {/* Main Content */}
                        <div className="flex-1 flex flex-col min-w-0">
                          <div className="p-3 border-b border-border flex gap-2">
                            <div className="relative flex-1">
                              <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                              <Input
                                placeholder={`Search ${loadedIcons[activeTab]?.length || 0} icons...`}
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
                                  No icons in the <span className="font-semibold text-foreground">{activeTab}</span> style match your search.
                                </p>
                              </div>
                            ) : (
                              <div className="grid grid-cols-6 gap-2" key={activeTab}>
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
                            {!iconBrowseQuery && filteredDisplayIcons.length < (loadedIcons[activeTab]?.length || 0) && (
                              <div className="p-4 text-center text-xs text-muted-foreground italic">
                                Showing top 300 icons. Search to find more...
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
              <p className="text-xs text-muted-foreground">
                Search and select an icon from the FontAwesome library.
              </p>
            </div>

            {/* Live Preview */}
            <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4">
              <p className="text-xs font-medium uppercase text-muted-foreground">Live preview</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Badge
                  hexColor={formValues.color}
                  icon={
                    currentIconDef
                      ? <FontAwesomeIcon icon={currentIconDef} className="text-[0.65rem]" />
                      : undefined
                  }
                  iconClass={!currentIconDef ? formValues.icon || null : null}
                  roleKind="user"
                  className="rounded-full px-3 py-1 text-sm shadow-sm"
                >
                  {formValues.name || 'Role Name'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {formValues.description || 'Description preview text'}
                </span>
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
