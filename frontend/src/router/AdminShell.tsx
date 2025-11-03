import { Outlet } from '@tanstack/react-router';
import { EnhancedAppLayout } from '../components';

export const AdminShell = () => {
  return (
    <EnhancedAppLayout showSidebar={true}>
      <Outlet />
    </EnhancedAppLayout>
  );
};

export default AdminShell;
