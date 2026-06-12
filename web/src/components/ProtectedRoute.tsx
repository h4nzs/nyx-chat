import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@store/auth';
import { Spinner } from './Spinner';

const ProtectedRoute = () => {
  const { user, hasRestoredKeys } = useAuthStore(state => ({
    user: state.user,
    hasRestoredKeys: state.hasRestoredKeys
  }));

  // Jika user belum login, arahkan ke login.
  if (user === null) {
    return <Navigate to="/login" replace />;
  }

  // Jika user sudah login tapi BELUM punya kunci (perangkat baru),
  // arahkan kembali ke login agar modal Identity Recovery muncul.
  if (!hasRestoredKeys) {
    return <Navigate to="/login" replace />;
  }
  
  // Jika user ada dan kunci siap, tampilkan konten rute yang diproteksi.
  return <Outlet />;
};

export default ProtectedRoute;
