import { createContext, useContext, ReactNode } from 'react';
import { useSession } from '../hooks/useSession';

export type Permission = string;

export type User = {
  id: number;
  uuid: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  user_type: string;
  is_active: boolean;
  created_at: string;
  has_admin_access?: boolean;
};

export type SessionData = {
  user: User;
  permissions: Permission[];
  csrf_token: string;
  setup_complete: boolean;
  feature_flags?: Record<string, boolean>;
  app_name?: string;
  app_version?: string;
};

export type AuthContextValue = {
  session: SessionData | null;
  user: User | null;
  permissions: Permission[];
  loading: boolean;
  error: Error | undefined;
  isAuthenticated: boolean;
  hasPermission: (permission: Permission) => boolean;
  hasAnyPermission: (...permissions: Permission[]) => boolean;
  hasAllPermissions: (...permissions: Permission[]) => boolean;
  isOwner: boolean;
  isAdministrator: boolean;
  hasAdminAccess: boolean;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const { session, loading, error, refresh } = useSession();

  const user = session?.user ?? null;
  const permissions = session?.permissions ?? [];
  const isAuthenticated = !!user;
  const isOwner = user?.user_type === 'owner';

  // Check if user has administrator access (owner or user with admin roles)
  const hasAdminAccess = user?.has_admin_access ?? false;
  const isAdministrator = isOwner || hasAdminAccess;

  const hasPermission = (permission: Permission): boolean => {
    // Owner and administrators have all permissions
    if (isAdministrator) return true;
    // For backwards compatibility, check permissions array (contains role names)
    return permissions.includes(permission);
  };

  const hasAnyPermission = (...requiredPermissions: Permission[]): boolean => {
    if (isAdministrator) return true;
    return requiredPermissions.some((perm) => permissions.includes(perm));
  };

  const hasAllPermissions = (...requiredPermissions: Permission[]): boolean => {
    if (isAdministrator) return true;
    return requiredPermissions.every((perm) => permissions.includes(perm));
  };

  const value: AuthContextValue = {
    session,
    user,
    permissions,
    loading,
    error,
    isAuthenticated,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    isOwner,
    isAdministrator,
    hasAdminAccess,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
