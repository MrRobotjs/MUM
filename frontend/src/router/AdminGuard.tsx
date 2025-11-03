import { Navigate, Outlet, useLocation } from '@tanstack/react-router';
import { useSession } from '../hooks/useSession';
import { ApiError } from '../util/apiClient';

type Props = {
  children?: React.ReactNode
}

const AdminGuard = ({ children }: Props) => {
  const location = useLocation();
  const { session, loading, error } = useSession();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200 text-base-content/70">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (error && (error as ApiError).status === 401) {
    return <Navigate to="/auth/login" replace state={{ from: location.pathname }} />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-200">
        <div className="max-w-md rounded-xl border border-error/30 bg-error/10 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-error">Unable to load admin session</h2>
          <p className="text-sm text-error/80">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!session?.user?.has_admin_access) {
    return <Navigate to="/auth/login" replace state={{ from: location.pathname }} />;
  }

  // If children are provided, render them, otherwise fall back to an Outlet
  return children ? <>{children}</> : <Outlet />;
};

export default AdminGuard;
