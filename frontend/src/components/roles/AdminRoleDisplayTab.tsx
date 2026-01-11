import { useState, useEffect, useRef, useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { IconTag, IconAlignLeft, IconPalette, IconIcons, IconDeviceFloppy, IconSparkles, IconInfoCircle, IconSearch, IconX, IconGridDots, IconWand, IconCheck } from '@tabler/icons-react'
import { AdminRole } from '../../hooks/useAdminRoles'
import { useAlerts, useTheme } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Badge as RoleBadge } from '@/components/common/Badge'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { getReadableTextColor, resolveCssVarHex } from '@/lib/themeColors'
import { AtSign, Square, SquareDashed } from 'lucide-react'

interface AdminRoleDisplayTabProps {
  role: AdminRole
  onUpdate: () => Promise<void>
}

const BASE_PRESET_COLORS: Array<{ hex: string; label: string }> = [
  { hex: '#f04747', label: 'Red' },
  { hex: '#faa61a', label: 'Orange' },
  { hex: '#fee75c', label: 'Yellow' },
  { hex: '#57f287', label: 'Green' },
  { hex: '#5865f2', label: 'Blurple' },
  { hex: '#eb459e', label: 'Pink' },
  { hex: '#9c84ef', label: 'Purple' },
  { hex: '#808080', label: 'Gray' },
]
const BADGE_STYLE_OPTIONS: Array<{ value: 'default' | 'fill' | 'outline'; label: string; description: string }> = [
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
]

type IconSetType = 'solid' | 'regular' | 'brands'
type LoadedIcon = {
  prefix: IconSetType
  iconName: string
  definition: IconDefinition
  label: string
}

const formatIconName = (name: string) => {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export const AdminRoleDisplayTab = ({ role, onUpdate }: AdminRoleDisplayTabProps) => {
  const { success, error: showError } = useAlerts()
  const { theme } = useTheme()
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const isMobile = useIsMobile()
  const themePrimaryHex = useMemo(
    () => resolveCssVarHex('--primary', '#3b82f6'),
    [theme]
  )
  const presetColors = BASE_PRESET_COLORS
  const [submitting, setSubmitting] = useState(false)

  const [formValues, setFormValues] = useState({
    name: role.name,
    description: role.description || '',
    color: role.color || themePrimaryHex,
    icon: role.icon || '',
    badge_style: role.badge_style || 'default',
  })

  const [iconBrowseOpen, setIconBrowseOpen] = useState(false)
  const [iconBrowseQuery, setIconBrowseQuery] = useState('')
  const [activeStyleFilters, setActiveStyleFilters] = useState<IconSetType[]>([])

  const [loadedIcons, setLoadedIcons] = useState<Record<IconSetType, LoadedIcon[]>>({ solid: [], regular: [], brands: [] })
  const [loadingIcons, setLoadingIcons] = useState(false)
  const [iconsLoaded, setIconsLoaded] = useState(false)

  useEffect(() => {
    setFormValues({
      name: role.name,
      description: role.description || '',
      color: role.color || themePrimaryHex,
      icon: role.icon || '',
      badge_style: role.badge_style || 'default',
    })
  }, [role, themePrimaryHex])

  useEffect(() => {
    if (iconBrowseOpen && !iconsLoaded && !loadingIcons) {
      const loadIcons = async () => {
        setLoadingIcons(true)
        try {
          const [solidPack, regularPack, brandsPack] = await Promise.all([
            import('@fortawesome/free-solid-svg-icons'),
            import('@fortawesome/free-regular-svg-icons'),
            import('@fortawesome/free-brands-svg-icons'),
          ])

          const processPack = (pack: any, prefix: IconSetType): LoadedIcon[] => {
            return Object.keys(pack)
              .filter((key) => key !== 'fas' && key !== 'far' && key !== 'fab' && key !== 'prefix' && pack[key].iconName)
              .map((key) => ({
                prefix,
                iconName: pack[key].iconName,
                definition: pack[key],
                label: formatIconName(pack[key].iconName),
              }))
          }

          setLoadedIcons({
            solid: processPack(solidPack, 'solid'),
            regular: processPack(regularPack, 'regular'),
            brands: processPack(brandsPack, 'brands'),
          })
          setIconsLoaded(true)
        } catch (err) {
          console.error('Failed to load icon packs:', err)
          showError('Failed to load full icon library. Some icons may be unavailable.')
        } finally {
          setLoadingIcons(false)
        }
      }

      loadIcons()
    }
  }, [iconBrowseOpen, iconsLoaded, loadingIcons, showError])

  const styleOptions: { id: IconSetType; label: string }[] = [
    { id: 'solid', label: 'Solid' },
    { id: 'regular', label: 'Regular' },
    { id: 'brands', label: 'Brands' },
  ]
  const styleIcons: Record<IconSetType, React.ComponentType<{ className?: string }>> = {
    solid: Square,
    regular: SquareDashed,
    brands: AtSign,
  }

  const filteredDisplayIcons = useMemo(() => {
    const activeStyles = activeStyleFilters.length > 0
      ? activeStyleFilters
      : (styleOptions.map((style) => style.id) as IconSetType[])
    let icons = activeStyles.flatMap((style) => loadedIcons[style] || [])

    if (iconBrowseQuery) {
      const q = iconBrowseQuery.toLowerCase()
      icons = icons.filter(
        (icon) =>
          icon.iconName.includes(q) ||
          icon.label.toLowerCase().includes(q)
      )
    }

    if (!iconBrowseQuery) {
      return icons.slice(0, 300)
    }

    return icons
  }, [activeStyleFilters, loadedIcons, iconBrowseQuery, styleOptions])

  const availableIconsCount = useMemo(() => {
    const activeStyles = activeStyleFilters.length > 0
      ? activeStyleFilters
      : (styleOptions.map((style) => style.id) as IconSetType[])
    return activeStyles.reduce((total, style) => total + (loadedIcons[style]?.length || 0), 0)
  }, [activeStyleFilters, loadedIcons, styleOptions])

  const handleBrowseOpenChange = (nextOpen: boolean) => {
    setIconBrowseOpen(nextOpen)
    if (nextOpen) {
      setIconBrowseQuery('')
      setActiveStyleFilters([])
    }
  }

  const handleIconSelect = (icon: LoadedIcon) => {
    const prefix = icon.prefix === 'brands' ? 'fa-brands' : icon.prefix === 'regular' ? 'fa-regular' : 'fa-solid'
    setFormValues((prev) => ({ ...prev, icon: `${prefix} fa-${icon.iconName}` }))
    setIconBrowseOpen(false)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)

    try {
      await requestJson(`/admin/api/v2/admin-roles/${role.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: formValues.name,
          description: formValues.description || null,
          color: formValues.color || null,
          icon: formValues.icon || null,
          badge_style: formValues.badge_style,
        }),
      })
      success('Display settings saved successfully')
      await onUpdate()
    } catch (err) {
      showError(`Failed to save settings: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Description Card */}
      <Alert variant="info">
        <IconInfoCircle />
        <AlertTitle>Role Configuration</AlertTitle>
        <AlertDescription>
          Customize the role's name, description, and visual appearance. Changes will be
          reflected throughout the interface.
        </AlertDescription>
      </Alert>

      {/* Basic Settings Section */}
      <div className="space-y-4">
        <h4 className="flex items-center gap-2 text-lg font-medium">
          <i className="fa-solid fa-id-badge text-sm text-primary" />
          Basic Settings
        </h4>

        {/* Role Name */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconTag className="size-4 text-primary" />
              <Label htmlFor="name" className="font-medium">
                Role Name
              </Label>
              <UiBadge variant="destructive" className="text-xs">
                Required
              </UiBadge>
            </div>
          </div>
          <Input
            id="name"
            value={formValues.name}
            onChange={(e) => setFormValues((prev) => ({ ...prev, name: e.target.value }))}
            required
            className="h-11"
          />
          <p className="mt-1 text-xs text-muted-foreground">A unique name for this role</p>
        </div>

        {/* Description */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconAlignLeft className="size-4 text-sky-600 dark:text-sky-400" />
              <Label htmlFor="description" className="font-medium">
                Description
              </Label>
              <UiBadge variant="secondary" className="text-xs">
                Optional
              </UiBadge>
            </div>
          </div>
          <Input
            id="description"
            value={formValues.description}
            onChange={(e) => setFormValues((prev) => ({ ...prev, description: e.target.value }))}
            className="h-11"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Optional description of what this role does
          </p>
        </div>
      </div>

      {/* Visual Appearance Section */}
      <div className="space-y-4">
        <h4 className="flex items-center gap-2 text-lg font-medium">
          <i className="fa-solid fa-palette text-sm text-amber-600 dark:text-amber-400" />
          Visual Appearance
        </h4>

        {/* Color */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconPalette className="size-4 text-amber-600 dark:text-amber-400" />
              <Label className="font-medium">Role Color</Label>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  className={cn(
                    'relative flex size-12 items-center justify-center rounded-full border border-border/60 shadow-sm transition',
                    'hover:border-border'
                  )}
                  style={{ backgroundColor: themePrimaryHex }}
                  title="Default color"
                  onClick={() => setFormValues((prev) => ({ ...prev, color: themePrimaryHex }))}
                >
                  {formValues.color.toLowerCase() === themePrimaryHex.toLowerCase() && (
                    <IconCheck
                      className="size-4"
                      style={{ color: getReadableTextColor(themePrimaryHex) }}
                    />
                  )}
                  <span className="sr-only">Default color</span>
                </button>
                <div
                  className="relative flex size-12 items-center justify-center rounded-full border border-white/40 shadow transition hover:shadow-md"
                  style={{ backgroundColor: formValues.color }}
                >
                  <IconWand
                    className="h-6 w-6 drop-shadow"
                    style={{ color: getReadableTextColor(formValues.color) }}
                  />
                  <Input
                    id="color"
                    type="color"
                    value={formValues.color}
                    onChange={(e) => setFormValues((prev) => ({ ...prev, color: e.target.value }))}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    aria-label="Choose badge color"
                  />
                </div>
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
            </div>

            <div>
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
                        'relative flex size-9 items-center justify-center rounded-full border-2 border-transparent transition',
                        'hover:border-border'
                      )}
                      style={{ backgroundColor: preset.hex }}
                      title={preset.label}
                      onClick={() => setFormValues((prev) => ({ ...prev, color: preset.hex }))}
                    >
                      {isSelected && (
                        <IconCheck
                          className="size-4"
                          style={{ color: getReadableTextColor(preset.hex) }}
                        />
                      )}
                      <span className="sr-only">{preset.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Icon */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconIcons className="size-4 text-indigo-600 dark:text-indigo-400" />
              <Label htmlFor="icon" className="font-medium">
                Icon
              </Label>
              <UiBadge variant="secondary" className="text-xs">
                Optional
              </UiBadge>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="icon"
                ref={iconInputRef}
                value={formValues.icon}
                onChange={(e) => setFormValues((prev) => ({ ...prev, icon: e.target.value }))}
                placeholder="e.g. fa-solid fa-star"
                className="h-11 pr-10 font-mono text-xs"
              />
              {formValues.icon && (
                <button
                  type="button"
                  onClick={() => setFormValues((prev) => ({ ...prev, icon: '' }))}
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
                  className="h-11 gap-2"
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
                <Button variant="outline" className="h-11 gap-2" type="button" onClick={() => handleBrowseOpenChange(true)}>
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
                                <RoleBadge
                                  color={isActive ? 'bg-primary' : 'bg-muted/60'}
                                  className={cn(
                                    'rounded-full px-3 py-1 text-xs font-medium gap-1',
                                    isActive ? 'text-primary-foreground' : 'text-muted-foreground'
                                  )}
                                  hover={false}
                                >
                                  <StyleIcon className="text-[0.65rem]" />
                                  {style.label}
                                </RoleBadge>
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
          <p className="mt-1 text-xs text-muted-foreground">
            Search and select an icon from the FontAwesome library.
          </p>
        </div>

        {/* Badge Style */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconSparkles className="size-4 text-purple-600 dark:text-purple-400" />
              <Label className="font-medium">Badge Style</Label>
            </div>
            <UiBadge variant="secondary" className="text-xs">
              Optional
            </UiBadge>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {BADGE_STYLE_OPTIONS.map((option) => {
              const isSelected = formValues.badge_style === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFormValues((prev) => ({ ...prev, badge_style: option.value }))}
                  aria-pressed={isSelected}
                  className={`flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition ${
                    isSelected
                      ? 'border-primary bg-primary/5 shadow-sm'
                      : 'border-border bg-muted/30 hover:border-border/60'
                  }`}
                >
                  <RoleBadge
                    hexColor={formValues.color}
                    iconClass={formValues.icon}
                    roleKind="admin"
                    badgeStyle={option.value}
                    className="rounded-full px-3 py-1 text-xs"
                  >
                    {formValues.name || 'Role Name'}
                  </RoleBadge>
                  <div>
                    <div className="text-xs font-semibold text-foreground">{option.label}</div>
                    <div className="text-[10px] text-muted-foreground">{option.description}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-3 border-t border-border pt-6">
        <Button type="submit" disabled={submitting} size="lg">
          <IconDeviceFloppy className="mr-2 size-4" />
          {submitting ? 'Saving...' : 'Save Display Settings'}
        </Button>
      </div>
    </form>
  )
}
