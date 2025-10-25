import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconGripVertical, IconAlertCircle, IconInfoCircle } from '@tabler/icons-react'
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
  type AdminPermission,
  type AdminRole,
} from '../hooks/useAdminRoles'
import { PageHeader } from '../components'
import { useAlerts } from '../contexts'
import { requestJson } from '../util/apiClient'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResponsiveDialog } from '@/components/ui/responsive-dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type RoleFormValues = {
  name: string
  description: string
  position: number
  color: string
  icon: string
  permission_ids: number[]
}

export const AdminRolesPage = () => {
  const navigate = useNavigate()
  const { roles, loading, error, refresh } = useAdminRoles(true, true)
  const { permissions } = useAdminPermissions()
  const { success, error: showError } = useAlerts()

  const [sortedRoles, setSortedRoles] = useState<AdminRole[]>([])
  const [reordering, setReordering] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<AdminRole | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formValues, setFormValues] = useState<RoleFormValues>({
    name: '',
    description: '',
    position: 0,
    color: '#3b82f6',
    icon: '',
    permission_ids: [],
  })

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
        color: role.color ?? '#3b82f6',
        icon: role.icon ?? '',
        permission_ids: role.permissions?.map((p) => p.id) ?? [],
      })
    } else {
      setFormValues({
        name: '',
        description: '',
        position: nextPosition,
        color: '#3b82f6',
        icon: '',
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
    navigate(`/admin/settings/admin-roles/${role.id}/edit`)
  }

  const handleDelete = async (role: AdminRole) => {
    if (role.is_staff_role) {
      showError('Cannot delete the Staff role')
      return
    }

    if (!window.confirm(`Delete admin role "${role.name}"?`)) {
      return
    }

    try {
      await requestJson(`/admin/api/v1/admin-roles/${role.id}`, {
        method: 'DELETE',
      })
      success('Role deleted successfully')
      await refresh()
    } catch (err) {
      showError(`Failed to delete role: ${(err as Error).message}`)
    }
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
        permission_ids: formValues.permission_ids,
      }

      if (editingRole) {
        await requestJson(`/admin/api/v1/admin-roles/${editingRole.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
        success('Role updated successfully')
      } else {
        await requestJson('/admin/api/v1/admin-roles', {
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
    }
  }

  const commitReorder = async (changedRoles: AdminRole[]) => {
    setReordering(true)
    try {
      await Promise.all(
        changedRoles.map((role) =>
          requestJson(`/admin/api/v1/admin-roles/${role.id}`, {
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
    if (sourceRole.is_staff_role || targetRole.is_staff_role) {
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
          <IconAlertCircle />
          <AlertTitle>Failed to load roles</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      ) : null}

      <Alert variant="info">
        <IconInfoCircle />
        <AlertTitle>Role hierarchy</AlertTitle>
        <AlertDescription>
          Drag roles using the handle to adjust their hierarchy. Higher positions have more
          authority.
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="p-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-secondary/20">
              <i className="fa-solid fa-shield-halved text-sm text-secondary" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Existing Roles</h3>
              <p className="text-sm text-muted-foreground">Admin roles with their permissions and hierarchy</p>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
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
                          <i className="fa-solid fa-shield-halved mb-2 text-2xl text-muted-foreground/30" />
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
                            disabled={role.is_staff_role || reordering}
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
        contentClassName="max-w-3xl"
      >
        <form id={formId} onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Role Name</Label>
            <Input
              id="name"
              value={formValues.name}
              onChange={(event) => setFormValues((prev) => ({ ...prev, name: event.target.value }))}
              required
              placeholder="Moderator"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={formValues.description}
              onChange={(event) =>
                setFormValues((prev) => ({ ...prev, description: event.target.value }))
              }
              placeholder="Describe the responsibilities for this role"
              rows={3}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="position">Position</Label>
              <Input
                id="position"
                type="number"
                min={0}
                value={formValues.position}
                onChange={(event) =>
                  setFormValues((prev) => ({
                    ...prev,
                    position: Number(event.target.value ?? 0),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Higher numbers represent greater authority.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="color">Role Color</Label>
              <Input
                id="color"
                type="color"
                className="h-10 w-24 cursor-pointer rounded-md border"
                value={formValues.color}
                onChange={(event) =>
                  setFormValues((prev) => ({ ...prev, color: event.target.value }))
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="icon">Icon (Font Awesome)</Label>
            <Input
              id="icon"
              value={formValues.icon}
              onChange={(event) => setFormValues((prev) => ({ ...prev, icon: event.target.value }))}
              placeholder="fa-shield"
            />
            <p className="text-xs text-muted-foreground">
              Use Font Awesome icon class names (e.g. fa-user-shield).
            </p>
          </div>

          <div className="space-y-2">
            <Label>Permissions</Label>
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
              {permissions.map((permission: AdminPermission) => {
                const checkboxId = `permission-${permission.id}`
                const checked = formValues.permission_ids.includes(permission.id)
                return (
                  <div
                    key={permission.id}
                    className="flex items-start gap-3 rounded-md border border-transparent px-2 py-2 hover:border-border"
                  >
                    <Checkbox
                      id={checkboxId}
                      checked={checked}
                      onCheckedChange={() => togglePermission(permission.id)}
                    />
                    <div className="space-y-1">
                      <Label htmlFor={checkboxId} className="text-sm font-medium">
                        {permission.name}
                      </Label>
                      {permission.description ? (
                        <p className="text-xs text-muted-foreground">
                          {permission.description}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )
              })}
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
    opacity: disabled ? 0.6 : undefined,
    userSelect: disabled ? undefined : 'none',
    WebkitUserSelect: disabled ? undefined : 'none',
    position: 'relative',
    zIndex: isDragging ? 5 : undefined,
  }

  const permissionCount = role.permissions?.length ?? 0

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
          <IconGripVertical className="size-5" />
        </button>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-full border-2"
            style={{
              backgroundColor: `${role.color || '#3b82f6'}20`,
              borderColor: `${role.color || '#3b82f6'}40`,
            }}
          >
            {role.icon ? (
              <i className={`fa-solid ${role.icon}`} style={{ color: role.color || '#3b82f6' }} />
            ) : (
              <i className="fa-solid fa-shield-halved" style={{ color: role.color || '#3b82f6' }} />
            )}
          </div>
          <div className="min-w-0 max-w-[200px] md:max-w-none">
            <div className="flex items-center gap-2">
              <div className="truncate font-medium">{role.name}</div>
              {role.is_staff_role && <Badge variant="secondary">Staff</Badge>}
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
            <i className="fa-solid fa-pen-to-square mr-1 size-3" />
            <span className="hidden md:inline">Edit</span>
          </Button>
          {!role.is_staff_role && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => onDelete(role)}
            >
              <i className="fa-solid fa-trash-can mr-1 size-3" />
              <span className="hidden md:inline">Delete</span>
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

export default AdminRolesPage
