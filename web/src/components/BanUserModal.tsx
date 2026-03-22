import { useState, useEffect } from 'react';
import ModalBase from './ui/ModalBase';
import { authFetch } from '@lib/api';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  targetUserId?: string; // Optional, if banning from list or profile directly
  onSuccess: () => void;
}

export default function BanUserModal({ isOpen, onClose, targetUserId, onSuccess }: Props) {
  const { t } = useTranslation(['modals', 'common']);
  const [userId, setUserId] = useState(targetUserId || '');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && targetUserId) {
      setUserId(targetUserId);
    }
  }, [isOpen, targetUserId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) return toast.error(t('modals:ban.no_id'));
    if (!reason.trim()) return toast.error(t('modals:ban.no_reason'));

    setLoading(true);
    try {
      await authFetch('/api/admin/ban', {
        method: 'POST',
        body: JSON.stringify({ userId, reason })
      });
      toast.success(t('modals:ban.success'));
      onSuccess();
      onClose();
      setReason('');
      if (!targetUserId) setUserId('');
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : 'Unknown error') || t('modals:ban.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalBase isOpen={isOpen} onClose={onClose} title={t('modals:ban.title')}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-bold uppercase text-text-secondary">{t('modals:ban.id_label')}</label>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="User ID..."
            className="w-full p-3 rounded-xl bg-bg-main text-text-primary border border-white/10 outline-none focus:border-red-500/50 font-mono"
            disabled={!!targetUserId} // Lock if ID passed via props
          />
        </div>
        
        <div className="flex flex-col gap-1">
          <label className="text-xs font-bold uppercase text-text-secondary">{t('modals:ban.reason_label')}</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('modals:ban.reason_placeholder')}
            className="
              w-full p-3 rounded-xl bg-bg-main text-text-primary 
              border border-white/10 outline-none focus:border-red-500/50
              min-h-[80px] resize-none
            "
            autoFocus
          />
        </div>

        <div className="flex justify-end gap-3 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-text-secondary hover:bg-white/5 transition-colors text-sm font-bold"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading}
            className="
              px-4 py-2 rounded-lg bg-red-500 text-white font-bold text-sm
              shadow-lg shadow-red-500/20 hover:bg-red-600 disabled:opacity-50
              transition-all
            "
          >
            {loading ? t('common:actions.executing') : t('modals:ban.execute')}
          </button>
        </div>
      </form>
    </ModalBase>
  );
}
