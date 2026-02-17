import { useState } from 'react';
import ModalBase from './ui/ModalBase';
import { authFetch } from '@lib/api';
import toast from 'react-hot-toast';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  reportedUserId: string;
  reportedUserName: string;
}

export default function ReportUserModal({ isOpen, onClose, reportedUserId, reportedUserName }: Props) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return toast.error("Please provide a reason.");

    setLoading(true);
    try {
      await authFetch('/api/reports/user', {
        method: 'POST',
        body: JSON.stringify({ reportedUserId, reason })
      });
      toast.success("Report submitted successfully.");
      onClose();
      setReason('');
    } catch (e: any) {
      toast.error(e.message || "Failed to submit report.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalBase isOpen={isOpen} onClose={onClose} title={`Report ${reportedUserName}`}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-text-secondary">
          Please provide specific details about why you are reporting this user.
          This will be sent to the moderation team.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for reporting (e.g., Spam, Harassment, Inappropriate Content)..."
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
            Cancel
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
            {loading ? 'Sending...' : 'Submit Report'}
          </button>
        </div>
      </form>
    </ModalBase>
  );
}
