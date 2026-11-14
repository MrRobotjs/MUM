import { PageHeader } from '../components';
import { useAuth } from '../contexts/AuthContext';

/** The administrator's home page; for now a greeting. */
export const AdminHomePage = () => {
  const { user } = useAuth();
  const name = user?.display_name || user?.username || '';
  return (
    <div className="space-y-6">
      <PageHeader title={name ? `Welcome ${name}` : 'Welcome'} />
    </div>
  );
};

export default AdminHomePage;
