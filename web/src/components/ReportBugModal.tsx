import { useState } from 'react';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { FiAlertCircle, FiX, FiCheck } from 'react-icons/fi';
import ModalBase from './ui/ModalBase';

interface Props {
  onClose: () => void;
}

export default function ReportBugModal({ onClose }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) {
        toast.error("Please fill in all fields");
        return;
    }

    setIsSubmitting(true);
    const toastId = toast.loading('Sending report...');

    try {
      // Otomatis ambil info browser/device user
      const deviceInfo = `${navigator.platform} - ${navigator.userAgent}`;

      await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ title, description, deviceInfo })
      });

      toast.success('Report sent! Thanks for your help.', { id: toastId });
      onClose();
    } catch (error) {
      console.error(error);
      toast.error('Failed to send report, try again later.', { id: toastId });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalBase isOpen={true} onClose={onClose} title="Report a Problem">
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg flex gap-3 text-sm text-blue-700 dark:text-blue-300">
            <FiAlertCircle className="flex-shrink-0 mt-0.5 text-lg" />
            <p>Found a bug? Describe it below. Device info will be included automatically to help us fix it.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Issue Summary</label>
          <input
            type="text"
            className="w-full p-2 rounded-lg bg-bg-main border border-border focus:ring-2 focus:ring-accent outline-none transition-all"
            placeholder="e.g. Cannot upload profile picture"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={100}
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Details</label>
          <textarea
            className="w-full p-2 rounded-lg bg-bg-main border border-border focus:ring-2 focus:ring-accent outline-none transition-all min-h-[120px] resize-none"
            placeholder="Describe what happened and steps to reproduce..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button 
            type="button" 
            onClick={onClose} 
            className="px-4 py-2 rounded-lg text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button 
            type="submit" 
            disabled={isSubmitting}
            className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium shadow-lg shadow-red-500/30 transition-all flex items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Sending...' : (
              <>
                <FiCheck /> Submit Report
              </>
            )}
          </button>
        </div>
      </form>
    </ModalBase>
  );
}