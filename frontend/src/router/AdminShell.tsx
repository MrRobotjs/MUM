import { Outlet } from 'react-router-dom';
import { EnhancedAppLayout } from '../components';

export const AdminShell = () => {
  return (
    <EnhancedAppLayout showSidebar={true}>
      <Outlet />
    </EnhancedAppLayout>
  );
};

export default AdminShell;
