import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faIdBadge,
  faPalette,
  faTag,
  faAlignLeft,
  faIcons,
  faFloppyDisk,
  faStar,
  faCircleInfo,
  faXmark,
  faGrip,
  faPaintbrush,
  faCheck,
} from '@fortawesome/free-solid-svg-icons'
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
 
import type { FontAwesomeBrowserIcon } from '@/components/icons/FontAwesomeIconBrowser'

const FontAwesomeIconBrowser = lazy(() => import('@/components/icons/FontAwesomeIconBrowser'))

interface AdminRoleDisplayTabProps {
  role: AdminRole
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
  const isDefaultColorSelected = formValues.color.toLowerCase() === themePrimaryHex.toLowerCase()

  const [iconBrowseOpen, setIconBrowseOpen] = useState(false)

  useEffect(() => {
    setFormValues({
      name: role.name,
      description: role.description || '',
      color: role.color || themePrimaryHex,
      icon: role.icon || '',
      badge_style: role.badge_style || 'default',
    })
  }, [role, themePrimaryHex])

  

  const handleBrowseOpenChange = (nextOpen: boolean) => {
    setIconBrowseOpen(nextOpen)
  }

  const handleIconSelect = (icon: FontAwesomeBrowserIcon) => {
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
        <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
        <AlertTitle>Role Configuration</AlertTitle>
        <AlertDescription>
          Customize the role's name, description, and visual appearance. Changes will be
          reflected throughout the interface.
        </AlertDescription>
      </Alert>

      {/* Basic Settings Section */}
      <div className="space-y-4">
        <h4 className="flex items-center gap-2 text-lg font-medium">
          <FontAwesomeIcon icon={faIdBadge} className="text-sm text-primary" />
          Basic Settings
        </h4>

        {/* Role Name */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faTag} className="size-4 text-primary" />
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
              <FontAwesomeIcon icon={faAlignLeft} className="size-4 text-sky-600 dark:text-sky-400" />
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
          <FontAwesomeIcon icon={faPalette} className="text-sm text-amber-600 dark:text-amber-400" />
          Visual Appearance
        </h4>

        {/* Color */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-3 space-y-1">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faPalette} className="size-4 text-amber-600 dark:text-amber-400" />
              <Label className="font-medium">Role Color</Label>
            </div>
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
              onClick={() => setFormValues((prev) => ({ ...prev, color: themePrimaryHex }))}
            >
              {isDefaultColorSelected && (
                <FontAwesomeIcon
                  icon={faCheck}
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
              <FontAwesomeIcon
                icon={faPaintbrush}
                className="absolute right-1 top-1 size-4 drop-shadow-md"
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
                    onClick={() => setFormValues((prev) => ({ ...prev, color: preset.hex }))}
                  >
                    {isSelected && (
                      <FontAwesomeIcon
                        icon={faCheck}
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

        {/* Icon */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faIcons} className="size-4 text-indigo-600 dark:text-indigo-400" />
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
                  <FontAwesomeIcon icon={faXmark} className="size-4" />
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
                  <FontAwesomeIcon icon={faGrip} className="size-4" />
                  Browse Icons
                </Button>
                <Suspense
                  fallback={(
                    <ResponsiveDialog
                      open={iconBrowseOpen}
                      onOpenChange={handleBrowseOpenChange}
                      title="Browse icons"
                      description="Choose a Font Awesome style and icon."
                    >
                      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                        Loading icon browser…
                      </div>
                    </ResponsiveDialog>
                  )}
                >
                  <FontAwesomeIconBrowser
                    open={iconBrowseOpen}
                    onOpenChange={handleBrowseOpenChange}
                    onSelect={handleIconSelect}
                    renderStyleBadge={({ isActive, label, StyleIcon }) => (
                      <RoleBadge
                        color={isActive ? 'bg-primary' : 'bg-muted/60'}
                        className={cn(
                          'rounded-full px-3 py-1 text-xs font-medium gap-1',
                          isActive ? 'text-primary-foreground' : 'text-muted-foreground'
                        )}
                        hover={false}
                      >
                        <StyleIcon className="text-[0.65rem]" />
                        {label}
                      </RoleBadge>
                    )}
                  />
                </Suspense>
              </>
            ) : (
              <>
                <Button variant="outline" className="h-11 gap-2" type="button" onClick={() => handleBrowseOpenChange(true)}>
                  <FontAwesomeIcon icon={faGrip} className="size-4" />
                  Browse Icons
                </Button>
                <Suspense
                  fallback={(
                    <ResponsiveDialog
                      open={iconBrowseOpen}
                      onOpenChange={handleBrowseOpenChange}
                      title="Browse icons"
                      description="Choose a Font Awesome style and icon."
                    >
                      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                        Loading icon browser…
                      </div>
                    </ResponsiveDialog>
                  )}
                >
                  <FontAwesomeIconBrowser
                    open={iconBrowseOpen}
                    onOpenChange={handleBrowseOpenChange}
                    onSelect={handleIconSelect}
                    renderStyleBadge={({ isActive, label, StyleIcon }) => (
                      <RoleBadge
                        color={isActive ? 'bg-primary' : 'bg-muted/60'}
                        className={cn(
                          'rounded-full px-3 py-1 text-xs font-medium gap-1',
                          isActive ? 'text-primary-foreground' : 'text-muted-foreground'
                        )}
                        hover={false}
                      >
                        <StyleIcon className="text-[0.65rem]" />
                        {label}
                      </RoleBadge>
                    )}
                  />
                </Suspense>
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
              <FontAwesomeIcon icon={faStar} className="size-4 text-purple-600 dark:text-purple-400" />
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
                  className={`flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition ${isSelected
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
          <FontAwesomeIcon icon={faFloppyDisk} className="mr-2 size-4" />
          {submitting ? 'Saving...' : 'Save Display Settings'}
        </Button>
      </div>
    </form>
  )
}
