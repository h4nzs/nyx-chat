import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@store/auth';
import { Spinner } from './Spinner';

const ProtectedRoute = () => {
  // Cek langsung dari store. Kita asumsikan bootstrap sudah dipanggil di App.tsx
  const user = useAuthStore(state => state.user);

  // Kita bisa anggap loading jika user masih null, karena bootstrap sedang berjalan.
  // Namun, untuk menghindari flash, kita perlu state loading yang lebih eksplisit.
  // Untuk saat ini, pengecekan user saja sudah cukup untuk memvalidasi.
  // Jika `user` null, bootstrap mungkin masih berjalan atau memang user belum login.
  // `App.tsx` sudah menangani pemanggilan bootstrap sekali.

  // Jika setelah bootstrap selesai user tetap null, maka arahkan ke login.
  if (user === null) {
    return <Navigate to="/login" replace />;
  }
  
  // Jika user ada, tampilkan konten rute yang diproteksi.
  // Outlet akan merender komponen anak dari rute (misal: <Home />, <Chat />)
  return <Outlet />;
};

export default ProtectedRoute;
