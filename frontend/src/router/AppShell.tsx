import { Outlet } from '@tanstack/react-router';
import { EnhancedAppLayout } from '../components';

export const AppShell = () => {
  return (
    <EnhancedAppLayout showSidebar={true}>
      <Outlet />
    </EnhancedAppLayout>
  );
};

export default AppShell;
