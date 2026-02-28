import { useAuthStore } from "@store/auth";
import { Participant } from "@store/conversation";
import { toAbsoluteUrl } from "@utils/url";
import { useState } from "react";
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { useModalStore } from '@store/modal';
import { useUserProfile } from "@hooks/useUserProfile";
import { DecryptedProfile } from "@store/profile";

const ParticipantActions = ({ conversationId, participant, profile, amIAdmin }: { conversationId: string, participant: Participant, profile: DecryptedProfile, amIAdmin: boolean }) => {
  const [isOpen, setIsOpen] = useState(false);
  const { user, blockUser, unblockUser, blockedUserIds } = useAuthStore();
  const showConfirm = useModalStore(s => s.showConfirm);

  if (user?.id === participant.id) {
    return null;
  }

  const isBlocked = blockedUserIds.includes(participant.id);

  const handleRoleChange = async (newRole: "ADMIN" | "MEMBER") => {
    setIsOpen(false);
    try {
      await api(`/api/conversations/${conversationId}/participants/${participant.id}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: newRole }),
      });
      toast.success(`${profile.name} is now ${newRole.toLowerCase()}.`);
    } catch (error: any) {
      toast.error(`Failed to change role: ${error.message || 'Unknown error'}`);
    }
  };

  const handleRemove = () => {
    setIsOpen(false);
    showConfirm(
      'Remove Participant',
      `Are you sure you want to remove ${profile.name} from the group?`,
      async () => {
        try {
          await api(`/api/conversations/${conversationId}/participants/${participant.id}`, {
            method: 'DELETE',
          });
          toast.success(`${profile.name} removed from group.`);
        } catch (error: any) {
          toast.error(`Failed to remove participant: ${error.message || 'Unknown error'}`);
        }
      }
    );
  };

  const handleBlockToggle = async () => {
    setIsOpen(false);
    try {
      if (isBlocked) {
        await unblockUser(participant.id);
        toast.success(`${profile.name} unblocked.`);
      } else {
        await blockUser(participant.id);
        toast.success(`${profile.name} blocked.`);
      }
    } catch (error: any) {
      toast.error(`Failed to ${isBlocked ? 'unblock' : 'block'} user: ${error.message || 'Unknown error'}`);
    }
  };

  return (
    <div className="relative">
      <button onClick={() => setIsOpen(!isOpen)} className="p-2 text-text-secondary hover:text-text-primary">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
      </button>
      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-bg-primary rounded-md shadow-lg z-10 border border-border">
          <ul className="py-1">
            {amIAdmin && participant.role === 'MEMBER' && (
              <li><button onClick={() => handleRoleChange('ADMIN')} className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-bg-surface">Make Admin</button></li>
            )}
            {amIAdmin && participant.role === 'ADMIN' && user?.id !== participant.id && (
              <li><button onClick={() => handleRoleChange('MEMBER')} className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-bg-surface">Dismiss as Admin</button></li>
            )}
            {amIAdmin && user?.id !== participant.id && (
              <li><button onClick={handleRemove} className="w-full text-left px-4 py-2 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground">Remove from Group</button></li>
            )}
            <li><button onClick={handleBlockToggle} className={`w-full text-left px-4 py-2 text-sm ${isBlocked ? 'text-green-500 hover:bg-green-500/10' : 'text-destructive hover:bg-destructive/10'}`}>
              {isBlocked ? 'Unblock User' : 'Block User'}
            </button></li>
          </ul>
        </div>
      )}
    </div>
  );
};

const ParticipantItem = ({ p, conversationId, amIAdmin, handleProfileClick }: { p: Participant, conversationId: string, amIAdmin: boolean, handleProfileClick: (p: Participant) => void }) => {
  const profile = useUserProfile(p as any);
  return (
    <li className="flex items-center justify-between p-2 rounded-lg hover:bg-secondary">
      <button onClick={() => handleProfileClick(p)} className="flex items-center gap-3 text-left min-w-0">
        <img
          src={toAbsoluteUrl(profile.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`}
          alt={profile.name}
          className="w-10 h-10 rounded-full object-cover bg-bg-primary flex-shrink-0"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`;
          }}
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text-primary truncate">{profile.name}</p>
          <p className="text-xs text-text-secondary truncate">{profile.description || 'No description'}</p>
          {p.role === 'ADMIN' && <p className="text-xs text-accent-color">Admin</p>}
        </div>
      </button>
      <ParticipantActions conversationId={conversationId} participant={p} profile={profile} amIAdmin={amIAdmin} />
    </li>
  );
};

const ParticipantList = ({ conversationId, participants, amIAdmin }: { conversationId: string, participants: Participant[], amIAdmin: boolean }) => {
  const openProfileModal = useModalStore(s => s.openProfileModal);

  const handleProfileClick = (participant: Participant) => {
    openProfileModal(participant.id);
  };

  return (
    <ul className="space-y-2">
      {participants.map(p => (
        <ParticipantItem key={p.id} p={p} conversationId={conversationId} amIAdmin={amIAdmin} handleProfileClick={handleProfileClick} />
      ))}
    </ul>
  );
};

export default ParticipantList;
