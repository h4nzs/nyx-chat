import { useEffect } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { parseUsernameHashSegment } from '@utils/usernameLink';

/**
 * [docs/30 §30.13 WS-I] Halaman link pendek `/u/<hashId>`.
 *
 * Hanya membawa hashId; halaman meneruskannya ke alur `/connect` yang sudah ada,
 * yang memanggil `/api/users/search` untuk pencocokan **persis**. Tidak ada
 * enumerasi: hashId salah bentuk ditolak di klien, dan hashId sah hanya
 * menemukan satu akun (atau nol).
 */
export default function UsernameLinkPage() {
  const { hashId } = useParams<{ hashId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation(['common']);

  const valid = parseUsernameHashSegment(hashId);

  useEffect(() => {
    if (!valid) {
      toast.error(t('common:connect.invalid_link', 'Invalid connection link'));
      navigate('/chat', { replace: true });
    }
  }, [valid, navigate, t]);

  if (!valid) return null;
  return <Navigate to={`/connect?u=${encodeURIComponent(valid)}`} replace />;
}
