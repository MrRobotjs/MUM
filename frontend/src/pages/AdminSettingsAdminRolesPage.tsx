import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import {
  useAdminPermissions,
  useAdminRoles,
  type AdminRole,
} from '../hooks/useAdminRoles'
import { PageHeader } from '../components'
import { useAlerts, useTheme } from '../contexts'
import { requestJson } from '../util/apiClient'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Badge as RoleBadge } from '@/components/common/Badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { getReadableTextColor, resolveCssVarHex } from '@/lib/themeColors'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Spinner } from '@/components/ui/spinner'
import { useResolvedIconDefinition } from '@/hooks/useResolvedIconDefinition'
import {
  faShieldHalved,
  faPenToSquare,
  faTrashCan,
  faGripVertical,
  faCircleExclamation,
  faCircleInfo,
  faShield,
  faIdBadge,
  faTag,
  faAlignLeft,
  faPalette,
  faKey,
  faIcons,
  faStar,
  faXmark,
  faGrip,
  faPaintbrush,
  faCheck,
} from '@fortawesome/free-solid-svg-icons'
import type { FontAwesomeBrowserIcon } from '@/components/icons/FontAwesomeIconBrowser'

const FontAwesomeIconBrowser = lazy(() => import('@/components/icons/FontAwesomeIconBrowser'))

type RoleFormValues = {
  name: string
  description: string
  position: number
  color: string
  icon: string
  badge_style: 'default' | 'fill' | 'outline'
  permission_ids: number[]
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

export const AdminSettingsAdminRolesPage = () => {
  const navigate = useNavigate()
  const { roles, loading, error, refresh } = useAdminRoles(true, false, true)
  const {
    permissions,
    loading: permissionsLoading,
    error: permissionsError,
  } = useAdminPermissions()
  const { success, error: showError } = useAlerts()
  const { theme } = useTheme()
  const isMobile = useIsMobile()
  const iconInputRef = useRef<HTMLInputElement | null>(null)
  const themePrimaryHex = useMemo(
    () => resolveCssVarHex('--primary', '#3b82f6'),
    [theme]
  )
  const presetColors = BASE_PRESET_COLORS

  const [sortedRoles, setSortedRoles] = useState<AdminRole[]>([])
  const [reordering, setReordering] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<AdminRole | null>(null)
  const [iconBrowseOpen, setIconBrowseOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formValues, setFormValues] = useState<RoleFormValues>({
    name: '',
    description: '',
    position: 0,
    color: themePrimaryHex,
    icon: '',
    badge_style: 'default',
    permission_ids: [],
  })
  const isDefaultColorSelected = formValues.color.toLowerCase() === themePrimaryHex.toLowerCase()

  useEffect(() => {
    setSortedRoles([...roles].sort((a, b) => a.position - b.position))
  }, [roles])

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 100,
        tolerance: 8,
      },
    })
  )

  const nextPosition = useMemo(() => {
    if (!sortedRoles.length) return 1
    return Math.max(...sortedRoles.map((role) => role.position)) + 1
  }, [sortedRoles])

  const formId = 'admin-role-form'

  const initializeForm = (role?: AdminRole | null) => {
    if (role) {
      setFormValues({
        name: role.name,
        description: role.description ?? '',
        position: role.position,
        color: role.color ?? themePrimaryHex,
        icon: role.icon ?? '',
        badge_style:
          role.badge_style === 'fill' || role.badge_style === 'outline'
            ? role.badge_style
            : 'default',
        permission_ids: role.permissions?.map((permission) => permission.id) ?? [],
      })
    } else {
      setFormValues({
        name: '',
        description: '',
        position: nextPosition,
        color: themePrimaryHex,
        icon: '',
        badge_style: 'default',
        permission_ids: [],
      })
    }
  }

  const handleCreate = () => {
    setEditingRole(null)
    initializeForm(null)
    setModalOpen(true)
  }

  const handleEdit = (role: AdminRole) => {
    navigate({
      to: '/admin/settings/admin-roles/$roleId/edit',
      params: { roleId: String(role.id) },
    })
  }

  const handleDelete = async (role: AdminRole) => {
    if (role.is_auto_managed) {
      showError('Cannot delete an auto-managed role')
      return
    }

    if (!window.confirm(`Delete admin role "${role.name}"?`)) {
      return
    }

    try {
      await requestJson(`/api/v2/admin-roles/${role.id}`, {
        method: 'DELETE',
      })
      success('Role deleted successfully')
      await refresh()
    } catch (err) {
      showError(`Failed to delete role: ${(err as Error).message}`)
    }
  }

  const handleBrowseOpenChange = (nextOpen: boolean) => {
    setIconBrowseOpen(nextOpen)
  }

  const handleIconSelect = (icon: FontAwesomeBrowserIcon) => {
    const prefix = icon.prefix === 'brands' ? 'fa-brands' : icon.prefix === 'regular' ? 'fa-regular' : 'fa-solid'
    setFormValues((prev) => ({ ...prev, icon: `${prefix} fa-${icon.iconName}` }))
    setIconBrowseOpen(false)
  }

  const togglePermission = (permissionId: number) => {
    setFormValues((prev) => {
      const selected = prev.permission_ids.includes(permissionId)
      return {
        ...prev,
        permission_ids: selected
          ? prev.permission_ids.filter((id) => id !== permissionId)
          : [...prev.permission_ids, permissionId],
      }
    })
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)

    try {
      const payload = {
        name: formValues.name,
        description: formValues.description || null,
        position: Number(formValues.position) || 0,
        color: formValues.color || null,
        icon: formValues.icon || null,
        badge_style: formValues.badge_style,
        permission_ids: formValues.permission_ids,
      }

      if (editingRole) {
        await requestJson(`/api/v2/admin-roles/${editingRole.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
        success('Role updated successfully')
      } else {
        await requestJson('/api/v2/admin-roles', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        success('Role created successfully')
      }

      setModalOpen(false)
      await refresh()
    } catch (err) {
      showError(`Failed to save role: ${(err as Error).message}`)
      throw err
    } finally {
      setSubmitting(false)
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setModalOpen(false)
      setEditingRole(null)
      setIconBrowseOpen(false)
    }
  }

  const commitReorder = async (changedRoles: AdminRole[]) => {
    setReordering(true)
    try {
      await Promise.all(
        changedRoles.map((role) =>
          requestJson(`/api/v2/admin-roles/${role.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ position: role.position }),
          })
        )
      )
      success('Role order updated')
      await refresh()
    } catch (err) {
      showError(`Failed to reorder roles: ${(err as Error).message}`)
      setSortedRoles([...roles].sort((a, b) => a.position - b.position))
    } finally {
      setReordering(false)
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) {
      return
    }

    const oldIndex = sortedRoles.findIndex((role) => role.id.toString() === String(active.id))
    const newIndex = sortedRoles.findIndex((role) => role.id.toString() === String(over.id))
    if (oldIndex === -1 || newIndex === -1) {
      return
    }

    const sourceRole = sortedRoles[oldIndex]
    const targetRole = sortedRoles[newIndex]
    if (sourceRole.is_auto_managed || targetRole.is_auto_managed) {
      return
    }

    const originalPositions = new Map(sortedRoles.map((role) => [role.id, role.position]))
    const reordered = arrayMove(sortedRoles, oldIndex, newIndex).map((role, idx) => ({
      ...role,
      position: idx + 1,
    }))

    setSortedRoles(reordered)

    const changedRoles = reordered.filter(
      (role) => role.position !== (originalPositions.get(role.id) ?? role.position)
    )
    if (changedRoles.length === 0) {
      return
    }

    await commitReorder(changedRoles)
  }

  const footerButtons = useMemo(
    () => [
      <Button
        key="cancel"
        type="button"
        variant="outline"
        onClick={() => setModalOpen(false)}
        disabled={submitting}
      >
        Cancel
      </Button>,
      <Button key="submit" type="submit" form={formId} disabled={submitting}>
        {submitting ? 'Saving…' : editingRole ? 'Save Changes' : 'Create Role'}
      </Button>,
    ],
    [editingRole, submitting]
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Roles"
        description="Manage admin roles and their permissions"
        actions={<Button onClick={handleCreate}>Create Role</Button>}
      />

      {error ? (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Failed to load roles</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      <Alert variant="info">
        <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
        <AlertTitle>Role hierarchy</AlertTitle>
        <AlertDescription>
          Drag roles using the handle to adjust their hierarchy. Higher positions have more
          authority.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faShield} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">Existing Roles</CardTitle>
              <CardDescription>Admin roles with their permissions and hierarchy</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : (
            <div className="w-full min-w-0 rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12"></TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Permissions</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Position</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRoles.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center">
                        <div className="text-muted-foreground">
                          <FontAwesomeIcon icon={faShieldHalved} className="mb-2 text-2xl text-muted-foreground/30" />
                          <p className="text-sm">No admin roles found. Create roles to assign permissions to administrators.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                      autoScroll={{ enabled: true }}
                    >
                      <SortableContext
                        items={sortedRoles.map((role) => role.id.toString())}
                        strategy={rectSortingStrategy}
                      >
                        {sortedRoles.map((role) => (
                          <SortableRoleRow
                            key={role.id}
                            role={role}
                            disabled={role.is_auto_managed || reordering}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={modalOpen}
        onOpenChange={handleOpenChange}
        title={editingRole ? 'Edit Admin Role' : 'Create Admin Role'}
        footer={footerButtons}
        contentClassName="max-w-4xl"
      >
        <form id={formId} onSubmit={handleSubmit} className="space-y-6">
          <Alert variant="info">
            <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
            <AlertTitle>Role Configuration</AlertTitle>
            <AlertDescription>
              Customize the role&apos;s name, description, and visual appearance. Changes will be
              reflected throughout the interface.
            </AlertDescription>
          </Alert>

          <div className="space-y-4">
            <h4 className="flex items-center gap-2 text-lg font-medium">
              <FontAwesomeIcon icon={faIdBadge} className="text-sm text-primary" />
              Basic Settings
            </h4>

            <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faTag} className="size-4 text-primary" />
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
                onChange={(event) => setFormValues((prev) => ({ ...prev, name: event.target.value }))}
                required
                className="h-11"
              />
              <p className="mt-1 text-xs text-muted-foreground">A unique name for this role</p>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faAlignLeft} className="size-4 text-sky-600 dark:text-sky-400" />
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
                onChange={(event) =>
                  setFormValues((prev) => ({ ...prev, description: event.target.value }))
                }
                className="h-11"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Optional description of what this role does
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <h4 className="flex items-center gap-2 text-lg font-medium">
              <FontAwesomeIcon icon={faPalette} className="text-sm text-amber-600 dark:text-amber-400" />
              Visual Appearance
            </h4>

            <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
              <div className="mb-3 space-y-1">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faPalette} className="size-4 text-amber-600 dark:text-amber-400" />
                  <Label className="font-medium">Role Color</Label>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
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
                    onChange={(event) => setFormValues((prev) => ({ ...prev, color: event.target.value }))}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    aria-label="Choose badge color"
                  />
                </div>

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

            <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faIcons} className="size-4 text-indigo-600 dark:text-indigo-400" />
                  <Label htmlFor="icon" className="font-medium">
                    Icon
                  </Label>
                  <Badge variant="secondary" className="text-xs">
                    Optional
                  </Badge>
                </div>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="icon"
                    ref={iconInputRef}
                    value={formValues.icon}
                    onChange={(event) => setFormValues((prev) => ({ ...prev, icon: event.target.value }))}
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
                <Button
                  variant="outline"
                  className="h-11 gap-2"
                  type="button"
                  onClick={() => handleBrowseOpenChange(true)}
                >
                  <FontAwesomeIcon icon={faGrip} className="size-4" />
                  {isMobile ? 'Browse' : 'Browse Icons'}
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
                        Loading icon browser...
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
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Search and select an icon from the FontAwesome library.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faStar} className="size-4 text-purple-600 dark:text-purple-400" />
                  <Label className="font-medium">Badge Style</Label>
                </div>
                <Badge variant="secondary" className="text-xs">
                  Optional
                </Badge>
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

          <div className="space-y-4">
            <h4 className="flex items-center gap-2 text-lg font-medium">
              <FontAwesomeIcon icon={faKey} className="text-sm text-primary" />
              Permissions
            </h4>

            <div className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/60">
              <div className="mb-3 flex items-center justify-between">
                <Label className="font-medium">Available Permissions</Label>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {permissions.length}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    Selected {formValues.permission_ids.length}
                  </Badge>
                </div>
              </div>

              <p className="mb-3 text-xs text-muted-foreground">
                Select permissions to assign to this role.
              </p>

              {permissionsLoading ? (
                <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Loading permissions...
                </div>
              ) : permissionsError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  Failed to load available permissions.
                </div>
              ) : permissions.length === 0 ? (
                <div className="rounded-md border p-3 text-sm text-muted-foreground">
                  No permissions available.
                </div>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
                  {permissions.map((permission) => (
                    <div
                      key={permission.id}
                      className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
                    >
                      <Checkbox
                        id={`permission-${permission.id}`}
                        checked={formValues.permission_ids.includes(permission.id)}
                        onCheckedChange={() => togglePermission(permission.id)}
                        className="mt-0.5"
                      />
                      <Label
                        htmlFor={`permission-${permission.id}`}
                        className="cursor-pointer space-y-1"
                      >
                        <p className="text-sm font-medium text-foreground">{permission.name}</p>
                        {permission.description ? (
                          <p className="text-xs text-muted-foreground">
                            {permission.description}
                          </p>
                        ) : null}
                      </Label>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </form>
      </ResponsiveDialog>
    </div>
  )
}

interface SortableRoleRowProps {
  role: AdminRole
  disabled: boolean
  onEdit: (role: AdminRole) => void
  onDelete: (role: AdminRole) => void
}

const SortableRoleRow = ({ role, disabled, onEdit, onDelete }: SortableRoleRowProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: role.id.toString(),
    disabled,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    userSelect: disabled ? undefined : 'none',
    WebkitUserSelect: disabled ? undefined : 'none',
    position: 'relative',
    zIndex: isDragging ? 5 : undefined,
  }

  const permissionCount = role.permissions?.length ?? 0
  const resolvedIconDef = useResolvedIconDefinition(role.icon)

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      className={cn('relative', isDragging && 'bg-primary/5 shadow-lg')}
    >
      <TableCell className="w-12">
        <button
          type="button"
          className={cn(
            'flex items-center justify-center text-muted-foreground',
            disabled ? 'cursor-default opacity-40' : 'cursor-grab active:cursor-grabbing touch-none'
          )}
          ref={setActivatorNodeRef}
          {...(!disabled ? { ...listeners, ...attributes } : {})}
          aria-label={`Reorder ${role.name}`}
        >
          <FontAwesomeIcon icon={faGripVertical} className="size-5" />
        </button>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-full border-2"
              style={{
                backgroundColor: `${role.color || themePrimaryHex}20`,
                borderColor: `${role.color || themePrimaryHex}40`,
              }}
          >
              <FontAwesomeIcon
                icon={resolvedIconDef ?? faShieldHalved}
                style={{ color: role.color || themePrimaryHex }}
              />
          </div>
          <div className="min-w-0 max-w-[200px] md:max-w-none">
            <div className="flex items-center gap-2">
              <div className="truncate font-medium">{role.name}</div>
              {role.is_auto_managed && <Badge variant="secondary">Auto-managed</Badge>}
            </div>
            {role.description && (
              <p className="truncate text-sm text-muted-foreground">{role.description}</p>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        {role.color ? (
          <div className="flex items-center gap-2">
            <span
              className="size-6 rounded-full border-2 border-border"
              style={{ backgroundColor: role.color }}
            />
            <span className="font-mono text-xs text-muted-foreground">{role.color}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Default</span>
        )}
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">
          {permissionCount}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">
          {role.user_count ?? 0}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">
          {role.position}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onEdit(role)}>
            <FontAwesomeIcon icon={faPenToSquare} className="mr-1 size-3" />
            <span className="hidden md:inline">Edit</span>
          </Button>
          {!role.is_auto_managed && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => onDelete(role)}
            >
              <FontAwesomeIcon icon={faTrashCan} className="mr-1 size-3" />
              <span className="hidden md:inline">Delete</span>
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

export default AdminSettingsAdminRolesPage
