import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';


import { useUserRoles, type UserRole } from '../hooks/useUserRoles';
import { PageHeader } from '../components';
import { Badge } from '@/components/common/Badge';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge as UiBadge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { requestJson } from '../util/apiClient';
import { useAlerts, useTheme } from '../contexts';
import { cn } from '@/lib/utils';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { resolveCssVarHex } from '@/lib/themeColors';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { Spinner } from '@/components/ui/spinner'
import {
  faTag,
  faTags,
  faPenToSquare,
  faTrashCan,
  faCircleInfo,
  faTriangleExclamation,
  faList,
  faPalette,
  faDroplet,
} from '@fortawesome/free-solid-svg-icons';

type RoleFormValues = {
  name: string;
  description: string;
  color: string;
  icon: string;
};

type IconSetType = 'solid' | 'regular' | 'brands';
const ICON_STYLE_TOKENS = new Set(['fa-solid', 'fa-regular', 'fa-brands', 'fa-light', 'fa-thin', 'fa-duotone']);
const ICON_MODIFIER_TOKENS = new Set([
  'fa-fw',
  'fa-xs',
  'fa-sm',
  'fa-lg',
  'fa-2x',
  'fa-3x',
  'fa-4x',
  'fa-5x',
  'fa-6x',
  'fa-7x',
  'fa-8x',
  'fa-9x',
  'fa-10x',
  'fa-spin',
  'fa-pulse',
  'fa-spin-pulse',
  'fa-spin-reverse',
  'fa-bounce',
  'fa-shake',
  'fa-beat',
  'fa-fade',
  'fa-flip',
  'fa-rotate-90',
  'fa-rotate-180',
  'fa-rotate-270',
  'fa-flip-horizontal',
  'fa-flip-vertical',
]);

const iconPackCache: Partial<Record<IconSetType, Map<string, IconDefinition>>> = {};
const iconPackPromiseCache: Partial<Record<IconSetType, Promise<Map<string, IconDefinition>>>> = {};
const iconDefinitionCache = new Map<string, IconDefinition>();

const parseIconClass = (iconClass?: string | null): { prefix: IconSetType; iconName: string } | null => {
  if (!iconClass) return null;
  const trimmed = iconClass.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const styleToken = tokens.find((token) => ICON_STYLE_TOKENS.has(token));
  const prefix: IconSetType = styleToken === 'fa-brands' ? 'brands' : styleToken === 'fa-regular' ? 'regular' : 'solid';
  const iconToken = tokens.find((token) => token.startsWith('fa-') && !ICON_STYLE_TOKENS.has(token) && !ICON_MODIFIER_TOKENS.has(token));
  if (!iconToken) return null;
  const iconName = iconToken.replace(/^fa-/, '');
  if (!iconName) return null;
  return { prefix, iconName };
};

const loadIconPack = async (prefix: IconSetType) => {
  if (iconPackCache[prefix]) {
    return iconPackCache[prefix]!;
  }
  if (iconPackPromiseCache[prefix]) {
    return iconPackPromiseCache[prefix]!;
  }

  const loader = async () => {
    const pack =
      prefix === 'brands'
        ? await import('@fortawesome/free-brands-svg-icons')
        : prefix === 'regular'
          ? await import('@fortawesome/free-regular-svg-icons')
          : await import('@fortawesome/free-solid-svg-icons');
    const map = new Map<string, IconDefinition>();
    Object.keys(pack).forEach((key) => {
      const value = (pack as Record<string, IconDefinition>)[key];
      if (value && (value as IconDefinition).iconName) {
        map.set(value.iconName, value);
      }
    });
    iconPackCache[prefix] = map;
    return map;
  };

  const promise = loader();
  iconPackPromiseCache[prefix] = promise;
  return promise;
};

const useResolvedIconDefinition = (iconClass?: string | null) => {
  const [definition, setDefinition] = useState<IconDefinition | null>(null);
  const parsed = useMemo(() => parseIconClass(iconClass), [iconClass]);
  const cacheKey = parsed ? `${parsed.prefix}:${parsed.iconName}` : null;

  useEffect(() => {
    if (!parsed || !cacheKey) {
      setDefinition(null);
      return;
    }

    const cached = iconDefinitionCache.get(cacheKey);
    if (cached) {
      setDefinition(cached);
      return;
    }

    let cancelled = false;
    loadIconPack(parsed.prefix)
      .then((pack) => {
        if (cancelled) return;
        const found = pack.get(parsed.iconName) ?? null;
        if (found) {
          iconDefinitionCache.set(cacheKey, found);
        }
        setDefinition(found);
      })
      .catch(() => {
        if (!cancelled) {
          setDefinition(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [parsed, cacheKey]);

  return definition;
};

const presetColors: Array<{ hex: string; label: string }> = [
  { hex: '#f04747', label: 'Red' },
  { hex: '#faa61a', label: 'Orange' },
  { hex: '#fee75c', label: 'Yellow' },
  { hex: '#57f287', label: 'Green' },
  { hex: '#5865f2', label: 'Blurple' },
  { hex: '#eb459e', label: 'Pink' },
  { hex: '#9c84ef', label: 'Purple' },
  { hex: '#808080', label: 'Gray' },
];

const isAutoManagedRole = (role: UserRole) => Boolean(role.is_auto_managed);

export const AdminSettingsUserRolesPage = () => {
  const navigate = useNavigate();
  const { roles, loading, error, refresh } = useUserRoles(false, true);
  const { success, error: showError } = useAlerts();
  const { theme } = useTheme();
  const themePrimaryHex = useMemo(
    () => resolveCssVarHex('--primary', '#3b82f6'),
    [theme]
  );
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<UserRole | null>(null);
  const [formValues, setFormValues] = useState<RoleFormValues>({
    name: '',
    description: '',
    color: themePrimaryHex,
    icon: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const RoleIconCircle = ({ iconClass, color }: { iconClass?: string | null; color: string }) => {
    const resolved = useResolvedIconDefinition(iconClass);
    return (
      <FontAwesomeIcon icon={resolved ?? faTag} style={{ color }} />
    );
  };

  const handleCreate = () => {
    setEditingRole(null);
    setFormValues({
      name: '',
      description: '',
      color: themePrimaryHex,
      icon: '',
    });
    setModalOpen(true);
  };

  const handleEdit = (role: UserRole) => {
    navigate({
      to: '/admin/settings/user-roles/$roleId/edit',
      params: { roleId: String(role.id) },
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const endpoint = editingRole
        ? `/api/v2/user-roles/${editingRole.id}`
        : '/api/v2/user-roles';
      const method = editingRole ? 'PATCH' : 'POST';

      await requestJson(endpoint, {
        method,
        body: JSON.stringify(formValues),
      });

      success(editingRole ? 'Role updated successfully' : 'Role created successfully');
      setModalOpen(false);
      await refresh();
    } catch (err) {
      showError(`Failed to save role: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (role: UserRole) => {
    if (isAutoManagedRole(role)) {
      showError(`Cannot delete the ${role.name} role`)
      return
    }
    if (!confirm(`Are you sure you want to delete "${role.name}"?`)) {
      return;
    }

    try {
      await requestJson(`/api/v2/user-roles/${role.id}`, {
        method: 'DELETE',
      });
      success('Role deleted successfully');
      await refresh();
    } catch (err) {
      showError(`Failed to delete role: ${(err as Error).message}`);
    }
  };

  const formId = 'user-role-form';

  const renderRoleForm = () => (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="name">
          Role Name
        </label>
        <Input
          id="name"
          value={formValues.name}
          onChange={(event) =>
            setFormValues({ ...formValues, name: event.target.value })
          }
          required
          placeholder="VIP Member"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="description">
          Description
        </label>
        <Textarea
          id="description"
          value={formValues.description}
          onChange={(event) =>
            setFormValues({ ...formValues, description: event.target.value })
          }
          placeholder="Short description shown alongside the badge."
          rows={3}
        />
      </div>

      <div className="space-y-3">
        <label className="text-sm font-medium text-foreground" htmlFor="color">
          Color
        </label>
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <span
                    className="flex size-12 items-center justify-center rounded-full border border-white/40 shadow"
                    style={{ backgroundColor: formValues.color }}
                  >
                <FontAwesomeIcon icon={faDroplet} className="h-6 w-6 text-white/80 drop-shadow" />
                  </span>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <FontAwesomeIcon icon={faPalette} className="h-4 w-4" />
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
              onChange={(event) =>
                setFormValues({ ...formValues, color: event.target.value })
              }
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
                const isSelected = preset.hex.toLowerCase() === formValues.color.toLowerCase();
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
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground" htmlFor="icon">
          Icon (FontAwesome)
        </label>
        <Input
          id="icon"
          value={formValues.icon}
          onChange={(event) =>
            setFormValues({ ...formValues, icon: event.target.value })
          }
          placeholder="fa-star"
        />
        <p className="text-xs text-muted-foreground">
          Use FontAwesome class names (e.g., fa-star, fa-crown).
        </p>
      </div>

      <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4">
        <p className="text-xs font-medium uppercase text-muted-foreground">Live preview</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Badge
            hexColor={formValues.color}
            iconClass={formValues.icon || null}
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
    </form>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Roles"
        description="Manage visual/cosmetic roles for users (badges, colors)"
        actions={
          <Button size="sm" onClick={handleCreate}>
            Create Role
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
          <AlertTitle>Unable to load roles</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Alert variant="info">
        <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
        <AlertTitle>Visual roles only</AlertTitle>
        <AlertDescription>
          User roles are cosmetic and do not grant permissions. Use Admin Roles to manage access
          levels.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faList} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">Existing Roles</CardTitle>
              <CardDescription>Badges and colors available to assign to users</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Color</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roles.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center">
                        <div className="text-muted-foreground">
                          <FontAwesomeIcon icon={faTags} className="mb-2 text-2xl text-muted-foreground/30" />
                          <p className="text-sm">No user roles found. Create roles to assign visual badges to users.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    roles.map((role) => (
                      <TableRow key={role.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div
                              className="flex size-10 shrink-0 items-center justify-center rounded-full border-2"
                              style={{
                                backgroundColor: `${role.color || '#808080'}20`,
                                borderColor: `${role.color || '#808080'}40`,
                              }}
                            >
                              <RoleIconCircle iconClass={role.icon} color={role.color || '#808080'} />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <div className="font-medium">{role.name}</div>
                                {isAutoManagedRole(role) && (
                                  <UiBadge variant="secondary">Auto-managed</UiBadge>
                                )}
                              </div>
                              {role.description && (
                                <p className="text-sm text-muted-foreground">{role.description}</p>
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
                            {role.user_count || 0}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {new Date(role.created_at).toLocaleDateString()}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => handleEdit(role)}>
                              <FontAwesomeIcon icon={faPenToSquare} className="mr-1 size-3" />
                              <span className="hidden md:inline">Edit</span>
                            </Button>
                            {!isAutoManagedRole(role) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:bg-destructive/10"
                                onClick={() => handleDelete(role)}
                              >
                                <FontAwesomeIcon icon={faTrashCan} className="mr-1 size-3" />
                                <span className="hidden md:inline">Delete</span>
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ResponsiveDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={editingRole ? 'Edit User Role' : 'Create User Role'}
        description="Define a visual badge that can be assigned to users."
        footer={[
          <Button
            key="cancel"
            type="button"
            variant="outline"
            onClick={() => setModalOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>,
          <Button key="save" type="submit" form={formId} disabled={submitting}>
            {submitting ? 'Saving…' : editingRole ? 'Update Role' : 'Create Role'}
          </Button>,
        ]}
      >
        {renderRoleForm()}
      </ResponsiveDialog>
    </div>
  );
};

export default AdminSettingsUserRolesPage;
