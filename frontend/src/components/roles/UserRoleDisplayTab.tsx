import { useState } from 'react'
import { IconPalette, IconDroplet, IconDeviceFloppy, IconInfoCircle } from '@tabler/icons-react'
import { UserRole } from '../../hooks/useUserRoles'
import { useAlerts } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { RoleBadge } from './RoleBadge'

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

export const UserRoleDisplayTab = ({ role, onUpdate }: UserRoleDisplayTabProps) => {
  const { success, error: showError } = useAlerts()
  const [formValues, setFormValues] = useState({
    name: role.name,
    description: role.description || '',
    color: role.color || '#3b82f6',
    icon: role.icon || '',
  })
  const [submitting, setSubmitting] = useState(false)

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
                      <IconDroplet className="h-6 w-6 text-white/80 drop-shadow" />
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

            {/* Icon */}
            <div className="space-y-2">
              <Label htmlFor="icon">Icon (FontAwesome)</Label>
              <Input
                id="icon"
                value={formValues.icon}
                onChange={(e) => setFormValues({ ...formValues, icon: e.target.value })}
                placeholder="fa-star"
              />
              <p className="text-xs text-muted-foreground">
                Use FontAwesome class names (e.g., fa-star, fa-crown).
              </p>
            </div>

            {/* Live Preview */}
            <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4">
              <p className="text-xs font-medium uppercase text-muted-foreground">Live preview</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <RoleBadge
                  label={formValues.name || 'Role Name'}
                  color={formValues.color}
                  icon={formValues.icon || null}
                  className="rounded-full px-3 py-1 text-sm shadow-sm"
                />
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
