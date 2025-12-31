import { useState, useEffect } from 'react'
import { IconTag, IconAlignLeft, IconPalette, IconIcons, IconEye, IconDeviceFloppy, IconSparkles, IconInfoCircle } from '@tabler/icons-react'
import { AdminRole } from '../../hooks/useAdminRoles'
import { useAlerts } from '../../contexts'
import { requestJson } from '../../util/apiClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

interface AdminRoleDisplayTabProps {
  role: AdminRole
  onUpdate: () => Promise<void>
}

const PRESET_COLORS = [
  { color: '#f04747', title: 'Red' },
  { color: '#faa61a', title: 'Orange' },
  { color: '#fee75c', title: 'Yellow' },
  { color: '#57f287', title: 'Green' },
  { color: '#5865f2', title: 'Blurple' },
  { color: '#eb459e', title: 'Pink' },
  { color: '#9c84ef', title: 'Purple' },
  { color: '#808080', title: 'Gray' },
]

export const AdminRoleDisplayTab = ({ role, onUpdate }: AdminRoleDisplayTabProps) => {
  const { success, error: showError } = useAlerts()
  const [submitting, setSubmitting] = useState(false)

  const [formValues, setFormValues] = useState({
    name: role.name,
    description: role.description || '',
    color: role.color || '#808080',
    icon: role.icon || '',
  })

  useEffect(() => {
    setFormValues({
      name: role.name,
      description: role.description || '',
      color: role.color || '#808080',
      icon: role.icon || '',
    })
  }, [role])

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
              <Badge variant="destructive" className="text-xs">
                Required
              </Badge>
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
              <IconAlignLeft className="size-4 text-secondary" />
              <Label htmlFor="description" className="font-medium">
                Description
              </Label>
              <Badge variant="secondary" className="text-xs">
                Optional
              </Badge>
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
          <i className="fa-solid fa-palette text-sm text-secondary" />
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

          {/* Color Input and Presets */}
          <div className="mb-4 flex gap-4">
            {/* Color Preview and Picker */}
            <div className="relative">
              <div
                className="h-11 w-12 cursor-pointer overflow-hidden rounded-lg border border-border"
                style={{ backgroundColor: formValues.color }}
              >
                <input
                  type="color"
                  value={formValues.color}
                  onChange={(e) => setFormValues((prev) => ({ ...prev, color: e.target.value }))}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
              </div>
            </div>

            {/* Preset Colors */}
            <div className="flex-1">
              <span className="mb-2 block text-xs font-medium text-muted-foreground">
                Preset Colors
              </span>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map(({ color, title }) => (
                  <div
                    key={color}
                    className="size-8 cursor-pointer rounded-full border-2 border-transparent transition-colors hover:border-border"
                    style={{ backgroundColor: color }}
                    title={title}
                    onClick={() => setFormValues((prev) => ({ ...prev, color }))}
                  />
                ))}
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Choose a color for role badges and highlights
          </p>
        </div>

        {/* Icon */}
        <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconIcons className="size-4 text-accent" />
              <Label htmlFor="icon" className="font-medium">
                Icon
              </Label>
              <Badge variant="secondary" className="text-xs">
                Optional
              </Badge>
            </div>
          </div>
          <Input
            id="icon"
            value={formValues.icon}
            onChange={(e) => setFormValues((prev) => ({ ...prev, icon: e.target.value }))}
            placeholder="e.g., fa-solid fa-star"
            className="h-11"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Find icons on{' '}
            <a
              href="https://fontawesome.com/search"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Font Awesome
            </a>
          </p>
        </div>
      </div>

      {/* Live Preview Section */}
      <div className="space-y-4">
        <h4 className="flex items-center gap-2 text-lg font-medium">
          <IconEye className="size-4 text-green-600 dark:text-green-400" />
          Live Preview
        </h4>

        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-green-100/20">
              <IconSparkles className="size-4 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h5 className="font-medium">Badge Preview</h5>
              <p className="text-xs text-muted-foreground">
                How the role badge will appear throughout the interface
              </p>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background p-6 text-center">
            <Badge
              variant="outline"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium ring-1 ring-inset"
              style={{
                backgroundColor: `${formValues.color}20`,
                color: formValues.color,
                borderColor: `${formValues.color}40`,
              }}
            >
              {formValues.icon && <i className={`${formValues.icon} size-3`} />}
              <span>{formValues.name || 'Role Name'}</span>
            </Badge>
          </div>
          <div className="mt-3 text-center">
            <span className="text-xs text-muted-foreground">
              Preview updates automatically as you make changes
            </span>
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
