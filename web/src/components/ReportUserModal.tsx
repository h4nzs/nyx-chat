import { useState } from 'react';
import ModalBase from './ui/ModalBase';
import { authFetch } from '@lib/api';
import toast from 'react-hot-toast';
import type { UserId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  reportedUserId: UserId;
  reportedUserName: string;
}

export default function ReportUserModal({ isOpen, onClose, reportedUserId, reportedUserName }: Props) {
  const { t } = useTranslation(['modals', 'common']);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return toast.error(t('modals:report.no_reason'));

    setLoading(true);
    try {
      await authFetch('/api/reports/user', {
        method: 'POST',
        body: JSON.stringify({ reportedUserId, reason })
      });
      toast.success(t('modals:report.success'));
      onClose();
      setReason('');
    } catch (e: unknown) {
      toast.error((e instanceof Error ? e.message : 'Unknown error') || t('modals:report.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalBase isOpen={isOpen} onClose={onClose} title={t('modals:report.title_user', { name: reportedUserName })}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-text-secondary">
          {t('modals:report.desc_user')}
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('modals:report.placeholder')}
          className="
            w-full p-3 rounded-xl bg-bg-main text-text-primary 
            border border-white/10 outline-none focus:border-red-500/50
            min-h-[100px] resize-none
          "
          autoFocus
        />
        <div className="flex justify-end gap-3 mt-2">
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
            {loading ? t('common:actions.sending') : t('modals:report.submit')}
          </button>
        </div>
      </form>
    </ModalBase>
  );
}
