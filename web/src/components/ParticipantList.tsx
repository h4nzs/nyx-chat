import { useAuthStore } from "@store/auth";
import { Participant } from "@store/conversation";
import { toAbsoluteUrl } from "@utils/url";
import { useState } from "react";
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { useModalStore } from '@store/modal';
import { useShallow } from 'zustand/react/shallow';
import { useUserProfile } from "@hooks/useUserProfile";
import { DecryptedProfile } from "@store/profile";
import type { ConversationId } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

const ParticipantActions = ({ conversationId, participant, profile, amIAdmin }: { conversationId: ConversationId, participant: Participant, profile: DecryptedProfile, amIAdmin: boolean }) => {
  const { t } = useTranslation(['modals']);
  const [isOpen, setIsOpen] = useState(false);
  const { user, blockUser, unblockUser, blockedUserIds } = useAuthStore(useShallow(s => ({
    user: s.user, blockUser: s.blockUser, unblockUser: s.unblockUser, blockedUserIds: s.blockedUserIds
  })));
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
      toast.success(t('participants.toasts.role_changed', { name: profile.name, role: newRole.toLowerCase() }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      toast.error(t('participants.toasts.role_failed', { error: msg }));
    }
  };

  const handleRemove = () => {
    setIsOpen(false);
    showConfirm(
      t('participants.remove_title'),
      t('participants.remove_desc', { name: profile.name }),
      async () => {
        try {
          await api(`/api/conversations/${conversationId}/participants/${participant.id}`, {
            method: 'DELETE',
          });
          toast.success(t('participants.toasts.removed', { name: profile.name }));
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          toast.error(t('participants.toasts.remove_failed', { error: msg }));
        }
      }
    );
  };

  const handleBlockToggle = async () => {
    setIsOpen(false);
    try {
      if (isBlocked) {
        await unblockUser(participant.id);
        toast.success(t('participants.toasts.unblocked', { name: profile.name }));
      } else {
        await blockUser(participant.id);
        toast.success(t('participants.toasts.blocked', { name: profile.name }));
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      toast.error(t('participants.toasts.block_failed', { error: msg }));
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
              <li><button onClick={() => handleRoleChange('ADMIN')} className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-bg-surface">{t('participants.make_admin')}</button></li>
            )}
            {amIAdmin && participant.role === 'ADMIN' && user?.id !== participant.id && (
              <li><button onClick={() => handleRoleChange('MEMBER')} className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-bg-surface">{t('participants.dismiss_admin')}</button></li>
            )}
            {amIAdmin && user?.id !== participant.id && (
              <li><button onClick={handleRemove} className="w-full text-left px-4 py-2 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground">{t('participants.remove')}</button></li>
            )}
            <li><button onClick={handleBlockToggle} className={`w-full text-left px-4 py-2 text-sm ${isBlocked ? 'text-green-500 hover:bg-green-500/10' : 'text-destructive hover:bg-destructive/10'}`}>
              {isBlocked ? t('participants.unblock') : t('participants.block')}
            </button></li>
          </ul>
        </div>
      )}
    </div>
  );
};

const ParticipantItem = ({ p, conversationId, amIAdmin, handleProfileClick }: { p: Participant, conversationId: ConversationId, amIAdmin: boolean, handleProfileClick: (p: Participant) => void }) => {
  const profile = useUserProfile(p);
  const { t } = useTranslation('modals'); // Only for "No description" fallback if needed, but here we can just leave it
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

const ParticipantList = ({ conversationId, participants, amIAdmin }: { conversationId: ConversationId, participants: Participant[], amIAdmin: boolean }) => {
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
