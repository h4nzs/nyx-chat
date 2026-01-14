import { useState } from 'react';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { Spinner } from './Spinner';
import ModalBase from './ui/ModalBase';

interface EditGroupInfoModalProps {
  conversationId: string;
  currentTitle: string;
  currentDescription: string | null;
  onClose: () => void;
}

export default function EditGroupInfoModal({ conversationId, currentTitle, currentDescription, onClose }: EditGroupInfoModalProps) {
  const [title, setTitle] = useState(currentTitle);
  const [description, setDescription] = useState(currentDescription || '');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await api(`/api/conversations/${conversationId}/details`, {
        method: 'PUT',
        body: JSON.stringify({ title, description }),
      });
      toast.success('Group info updated!');
      onClose();
    } catch (error: any) {
      toast.error(`Failed to update: ${error.message || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ModalBase
      isOpen={true}
      onClose={onClose}
      title="Edit Group Info"
      footer={(
        <>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-md text-text-primary bg-secondary hover:bg-secondary/80">
            Cancel
          </button>
          <button type="submit" form="edit-group-form" disabled={isLoading} className="btn btn-primary">
            {isLoading && <Spinner size="sm" className="mr-2" />} 
            Save Changes
          </button>
        </>
      )}
    >
      <form id="edit-group-form" onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="group-title" className="block text-sm font-medium text-text-secondary mb-1">Group Name</label>
            <input
              id="group-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full p-2 rounded-md bg-bg-surface focus:outline-none focus:ring-2 focus:ring-accent shadow-neumorphic-concave"
            />
        </div>
        <div>
          <label htmlFor="group-description" className="block text-sm font-medium text-text-secondary mb-1">Description</label>
          <textarea
            id="group-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full p-2 bg-background border border-border rounded-md text-text-primary"
          />
        </div>
      </form>
    </ModalBase>
  );
}