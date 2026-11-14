import {getAccessToken} from '../../store/authStore'
import {changeAdminRole, valuesFromRole} from '../../lib/adminRoleChanges'
import {useAuth} from '../../contexts/AuthContext'
import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCog, faPalette, faFloppyDisk, faCircleInfo, faXmark, faPaintbrush, faGrip, faCheck } from '@fortawesome/free-solid-svg-icons'
import { AdminRole } from '../../hooks/useAdminRoles'
import { useAlerts, useTheme } from '../../contexts'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge as CommonBadge, RoleBadge } from '@/components/common/Badge'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { getReadableTextColor, resolveCssVarHex } from '@/lib/themeColors'
import { PRESET_ROLE_COLORS, ROLE_BADGE_STYLE_OPTIONS } from '@/components/roles/roleFormConstants'
import { Spinner } from '@/components/ui/spinner'

import type { FontAwesomeBrowserIcon } from '@/components/icons/FontAwesomeIconBrowser'

const FontAwesomeIconBrowser = lazy(() => import('@/components/icons/FontAwesomeIconBrowser'))

interface AdminRoleDisplayTabProps {
  role: AdminRole
  onUpdate: () => Promise<void>
}

// Laid out like the user role Display tab (Visual Display, then one Role
// Settings card); saving uses the admin role change rules.
export const AdminRoleDisplayTab = ({ role, onUpdate }: AdminRoleDisplayTabProps) => {
  const { success, info, error: showError } = useAlerts()
  const {user} = useAuth()
  const active = useRef(true)
  useEffect(() => {active.current=true;return()=>{active.current=false}}, [])
  const [baseRole, setBaseRole] = useState(role)
  const { theme } = useTheme()
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const isMobile = useIsMobile()
  const themePrimaryHex = useMemo(
    () => resolveCssVarHex('--primary', '#3b82f6'),
    [theme]
  )
  const presetColors = PRESET_ROLE_COLORS
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
    setBaseRole(role)
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
    if (!role.mutations_available) return
    // The server refuses an unchanged save; say so instead of sending it.
    const saved = { name: baseRole.name, description: baseRole.description || '', color: baseRole.color || themePrimaryHex, icon: baseRole.icon || '', badge_style: baseRole.badge_style || 'default' }
    if ((Object.keys(saved) as Array<keyof typeof saved>).every((key) => saved[key] === formValues[key])) {
      info('No changes to save')
      return
    }
    const token = getAccessToken()
    setSubmitting(true)

    try {
      if (!user) throw new Error('Sign in as the owner before saving.')
      await changeAdminRole({actor_uuid:user.uuid,snapshot_revision:baseRole.snapshot_revision,mutations_available:baseRole.mutations_available}, 'update', baseRole, {...valuesFromRole(baseRole),name:formValues.name,description:formValues.description || null,color:formValues.color || null,icon:formValues.icon || null,badge_style:formValues.badge_style})
      if (!active.current || token !== getAccessToken()) return
      success('Display settings saved successfully')
      await onUpdate()
    } catch (err) {
      if (!active.current || token !== getAccessToken()) return
      showError(`Failed to save settings: ${(err as Error).message}`)
    } finally {
      if (active.current) setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Display Settings Overview */}
      <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
            <FontAwesomeIcon icon={faPalette} className="size-5 text-primary" />
            </div>
          <div>
            <h2 className="mb-1 text-xl font-semibold">Visual Display</h2>
            <p className="text-sm text-muted-foreground">
              Customize how this role badge appears to users
            </p>
          </div>
        </div>

        <Alert variant="info">
          <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
          <AlertTitle>Display Only</AlertTitle>
          <AlertDescription>
            These settings change how the role badge looks. What the role can do is set on the Permissions tab.
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
                placeholder="Moderator"
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formValues.description}
                onChange={(e) => setFormValues((prev) => ({ ...prev, description: e.target.value }))}
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
                  {/* Edit Pencil Icon (using Wand to avoid new import for now, or could check if Pencil exists) */}
                  <FontAwesomeIcon
                    icon={faPaintbrush}
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
                      <FontAwesomeIcon icon={faXmark} className="size-4" />
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
                      />
                    </Suspense>
                  </>
                ) : (
                  <>
                    <Button variant="outline" className="gap-2" type="button" onClick={() => handleBrowseOpenChange(true)}>
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
                          <CommonBadge color={isActive ? 'bg-primary' : 'bg-muted/60'} icon={<StyleIcon />} shape="pill" hover={false}>
                        {label}
                      </CommonBadge>
                        )}
                      />
                    </Suspense>
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
                {ROLE_BADGE_STYLE_OPTIONS.map((option) => {
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
                      <RoleBadge kind="admin" role={{ name: formValues.name || 'Role Name', color: formValues.color, icon: formValues.icon || null, badge_style: option.value }} />
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
          <Button type="submit" disabled={submitting || !role.mutations_available}>
            {submitting ? (
              <>
                <Spinner className="mr-2 size-4 text-background" />
                Saving...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faFloppyDisk} className="mr-2 size-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
