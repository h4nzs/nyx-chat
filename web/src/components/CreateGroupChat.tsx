import DefaultAvatar from "@/components/ui/DefaultAvatar";
import { useState, useMemo, useEffect } from 'react';
import { useConversationStore, type Conversation } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';
import { toAbsoluteUrl } from '@utils/url';
import { transportClient, } from '@lib/transportClient';
import { useUserSearch } from '@hooks/useUserSearch';
import toast from 'react-hot-toast';
import useDynamicIslandStore from '@store/dynamicIsland';
import { useProfileStore, hydrateProfileForPlainId } from '@store/profile';
import { useVerificationStore } from '@store/verification';
import ModalBase from './ui/ModalBase';
import { FiCheck, FiShield, FiUserCheck } from 'react-icons/fi';
import type { UserId, MinimalProfile } from '@nyx/shared';
import { getParticipantUserId } from '@nyx/shared';
import { computeContactTrust, compareByTrustDescThenRecency, type ContactTrustLevel } from '@lib/contactTrust';
import type { ContactRecord } from '@nyx/shared';
import { useTranslation } from 'react-i18next';

// [CONTACT TRUST — P4 2026-10-05] Baris kontak untuk picker: dekripsi profil
// via profileStore (pola yang sama dengan ContactItem CreateStoryModal) +
// badge level trust.
const ContactRow = ({ contact, isSelected, onSelect }: {
  contact: ContactRecord & { trust: ContactTrustLevel };
  isSelected: boolean;
  onSelect: (profile: MinimalProfile) => void;
}) => {
  const { t } = useTranslation(['common']);
  const uid = String(contact.userId);
  // [FIX UI ANONYMOUS 2026-10-05] Baca key komposit DULU alias plain-id —
  // profil yang didekripsi jalur mana pun (pesan/prefetch/kontak lain) selalu
  // dual-write ke alias, jadi baris kontak tanpa encryptedProfile pun
  // mendapatkan nama/avatar. Dulu: satu key saja → "Anonymous" senyap.
  const profile = useProfileStore(state => {
    const composite = contact.encryptedProfile ? `${uid}_${contact.encryptedProfile.substring(0, 32)}` : uid;
    return state.profiles[composite] ?? state.profiles[uid];
  });

  useEffect(() => {
    if (profile) return;
    if (contact.encryptedProfile) {
      void useProfileStore.getState().decryptAndCache(contact.userId, contact.encryptedProfile);
    } else {
      // ep kosong di record kontak → hidrasi dari RAM/IDB (bukan "Anonymous")
      void hydrateProfileForPlainId(contact.userId);
    }
  }, [contact.userId, contact.encryptedProfile, profile]);

  const name = profile?.name || contact.alias || '';
  const avatarUrl = profile?.avatarUrl || undefined;

  return (
    <div
      onClick={() => onSelect({ id: contact.userId as unknown as UserId, name, username: profile?.username || '', avatarUrl: avatarUrl ?? null })}
      className={`
        relative flex items-center gap-4 p-3 rounded-xl cursor-pointer transition-all duration-300
        border border-transparent
        bg-bg-main shadow-[5px_5px_10px_rgba(0,0,0,0.1),-5px_-5px_10px_rgba(255,255,255,0.8)] dark:shadow-[4px_4px_8px_rgba(0,0,0,0.4),-4px_-4px_8px_rgba(255,255,255,0.03)] hover:-translate-y-0.5
      `}
    >
      <div className="relative">
        {avatarUrl ? (
          <img src={toAbsoluteUrl(avatarUrl)} className={`w-10 h-10 rounded-full object-cover transition-all ${isSelected ? 'grayscale-0' : 'grayscale opacity-80'}`} alt={name} />
        ) : (
          <DefaultAvatar name={name} id={String(contact.userId)} className={`w-10 h-10 transition-all ${isSelected ? 'grayscale-0' : 'grayscale opacity-80'}`} />
        )}
        <div className={`
          absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300
          ${isSelected ? 'bg-accent scale-100 shadow-neu-icon' : 'bg-transparent scale-0'}
        `}>
          <FiCheck size={10} className="text-white" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <h4 className={`text-sm font-bold truncate transition-colors ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
          {name || t('common:defaults.anonymous', 'Anonymous')}
        </h4>
        {profile?.username && <p className="text-xs text-text-secondary font-mono truncate">@{profile.username}</p>}
      </div>
      <span
        title={contact.trust === 'verified' ? t('common:contact_trust_verified') : t('common:contact_trust_known')}
        className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full shrink-0 ${
          contact.trust === 'verified'
            ? 'text-green-600 bg-green-500/10 dark:text-green-400'
            : 'text-text-secondary bg-black/5 dark:bg-white/5'
        }`}
      >
        {contact.trust === 'verified' ? <FiShield size={10} /> : <FiUserCheck size={10} />}
        {contact.trust === 'verified' ? t('common:contact_trust_verified') : t('common:contact_trust_known')}
      </span>
    </div>
  );
};

export default function CreateGroupChat({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['modals', 'common']);
  const [title, setTitle] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<MinimalProfile[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const me = useAuthStore(s => s.user);
  const { createGroup, openConversation } = useConversationStore(useShallow(state => ({
    createGroup: state.createGroup,
    openConversation: state.openConversation,
  })));

  // [T4 UX] Pencarian ter-debounce + stale-guard via hook (dulu: debounce 300ms
  // lebih pendek dari hashUsername ~1.1s → hasil bisa kosong/out-of-order).
  // Filter sendiri/dirinya + yang sudah dipilih dilakukan di memo (bukan di
  // hook — hasil mentah tetap tersedia untuk render future).
  const { results: rawResults, isSearching } = useUserSearch(searchQuery);

  // [CONTACT TRUST — P4 2026-10-05] Bagian kontak dari CONTACT STORE (persisten
  // — survive reinstall/restore bundle), diurutkan per trust: verified
  // (safety-number 1:1 cocok) > known (pernah bertukar pesan). Blocked
  // disembunyikan dari picker. Profil didekripsi via profileStore per baris.
  const [vaultContacts, setVaultContacts] = useState<Array<ContactRecord & { trust: ContactTrustLevel }>>([]);
  const [showContactList, setShowContactList] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getAllContacts } = await import('@lib/contactStore');
        const contacts = await getAllContacts();
        // verifiedStatus keyed conversationId — resolve peer dari participants 1:1.
        const { verifiedStatus } = useVerificationStore.getState();
        const convs = useConversationStore.getState().conversations;
        const myId = me?.id;
        const verifiedPeers = new Set<string>();
        for (const c of convs) {
          if (c.isGroup || !verifiedStatus[c.id]) continue;
          // [P2 NORMALISASI] getParticipantUserId (dulu p.id buta).
          const peer = c.participants.find(p => getParticipantUserId(p) !== myId);
          if (peer) verifiedPeers.add(String(peer.id));
        }
        const blocked = new Set(useAuthStore.getState().blockedUserIds);
        const withTrust = contacts
          .filter(c => c.userId !== myId && !blocked.has(c.userId))
          .map(c => ({
            ...c,
            trust: computeContactTrust({ inContacts: true, isVerified: verifiedPeers.has(c.userId), blocked: blocked.has(c.userId) }),
          }))
          .sort(compareByTrustDescThenRecency);
        if (!cancelled) setVaultContacts(withTrust);
      } catch (_e) { /* non-fatal — picker search tetap jalan */ }
    })();
    return () => { cancelled = true; };
  }, [me?.id]);
  const userList = useMemo(() => {
    const rawQuery = searchQuery.trim();
    const selectedIdSet = new Set(selectedUsers.map(u => u.id));
    const knownUsers = useConversationStore.getState().conversations.flatMap(c => c.participants);
    return rawResults
      .filter(u => u.id !== me?.id && !selectedIdSet.has(u.id))
      .map(u => {
        const known = knownUsers.find(k => k.id === u.id);
        if (known?.name && known.name !== 'Unknown') {
          return { ...u, name: known.name, username: known.username || rawQuery };
        }
        return { ...u, username: rawQuery, name: rawQuery };
      });
  }, [rawResults, searchQuery, selectedUsers, me?.id]);

  const handleSelectUser = (user: MinimalProfile) => {
    const maxMembers = me?.subscriptionTier === 'SUBSCRIBER' ? 500 : 100;
    // selectedUsers.length is currently selected, +1 for the creator, but let's just use maxMembers - 1 for new selections
    if (selectedUsers.length >= maxMembers - 1) {
      if (me?.subscriptionTier !== 'SUBSCRIBER') {
        useDynamicIslandStore.getState().addActivity({
          type: 'upsell',
          message: `Group limit reached (${maxMembers} max). Upgrade to host 500 members.`
        }, 5000);
      } else {
        toast.error(t('modals:group_info.toasts.limit_reached', { defaultValue: `Group limit reached (${maxMembers} members max).` }));
      }
      return;
    }
    setSelectedUsers(prev => [...prev, user]);
    setSearchQuery('');
  };

  const handleRemoveUser = (userId: UserId) => {
    setSelectedUsers(prev => prev.filter(u => u.id !== userId));
  };

  const handleCreateGroup = async () => {
    if (!title.trim() || selectedUsers.length === 0) {
      return toast.error(t('modals:group_info.toasts.create_failed'));
    }
        setLoading(true);
        try {
      const conversationId = await createGroup(title.trim(), selectedUsers.map(u => u.id));



      openConversation(conversationId);

      toast.success(t('modals:group_info.toasts.created', { name: title }));
      onClose();

    } catch (error: unknown) {
      if (error instanceof Error) {
        toast.error(t('modals:group_info.toasts.create_error', { error: error.message }));
      } else {
        toast.error(t('common:errors.unknown'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalBase
      isOpen={true}
      onClose={onClose}
      title={t('modals:group_info.create_title')}
      footer={(
        <>
          <button onClick={onClose} disabled={loading} className="px-4 py-2 rounded-lg bg-bg-surface text-text-primary shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
            {t('common:actions.cancel')}
          </button>
          <button onClick={handleCreateGroup} disabled={loading || !title.trim() || selectedUsers.length === 0} className="px-4 py-2 rounded-lg bg-accent text-white shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all">
            {loading ? t('common:actions.creating') : t('common:actions.create_group')}
          </button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <input
          type="text"
          placeholder={t('modals:edit_group.group_name')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full input-neumorphic mb-4"
        />

        {/* [P4] Kontak yang pernah bertukar pesan — sorted by trust (verified dulu) */}
        {vaultContacts.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowContactList(v => !v)}
              className="flex w-full items-center justify-between px-1 py-2 text-xs font-bold uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
            >
              <span>{t('common:contact_picker_title', { count: vaultContacts.length })}</span>
              <span className={`transition-transform ${showContactList ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {showContactList && (
              <div className="max-h-60 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                {vaultContacts
                  .filter(c => !selectedUsers.some(u => u.id === String(c.userId)))
                  .map(contact => (
                    <ContactRow key={String(contact.userId)} contact={contact} isSelected={false} onSelect={handleSelectUser} />
                  ))}
                {vaultContacts.every(c => selectedUsers.some(u => u.id === String(c.userId))) && (
                  <p className="text-xs text-text-secondary text-center py-3">{t('common:contact_picker_all_selected')}</p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('modals:add_participant.search_placeholder')}
            className="w-full input-neumorphic"
          />
          {isSearching && (
            <p className="text-sm text-text-secondary mt-2">{t('modals:add_participant.searching')}</p>
          )}
          {userList.length > 0 && (
            <div className="absolute top-full left-0 right-0 max-h-60 overflow-y-auto z-10 rounded-xl p-2 space-y-2 bg-bg-main/50 backdrop-blur-md shadow-neu-flat dark:shadow-neu-flat-dark border border-text-secondary/10 mt-2">
              {userList.map(user => {
                const isSelected = selectedUsers.some(u => u.id === user.id);
                return (
                  <div 
                    key={user.id}
                    onClick={() => handleSelectUser(user)}
                    className={`
                      relative flex items-center gap-4 p-3 rounded-xl cursor-pointer transition-all duration-300
                      border border-transparent
                      bg-bg-main shadow-[5px_5px_10px_rgba(0,0,0,0.1),-5px_-5px_10px_rgba(255,255,255,0.8)] dark:shadow-[4px_4px_8px_rgba(0,0,0,0.4),-4px_-4px_8px_rgba(255,255,255,0.03)] hover:-translate-y-0.5
                    `}
                  >
                    <div className="relative">
                      {user.avatarUrl ? (
                        <img
                          src={toAbsoluteUrl(user.avatarUrl)}
                          className={`w-10 h-10 rounded-full object-cover transition-all ${isSelected ? 'grayscale-0' : 'grayscale opacity-80'}`}
                          alt={user.name}
                        />
                      ) : (
                        <DefaultAvatar name={user.name} id={user.id} className={`w-10 h-10 transition-all ${isSelected ? 'grayscale-0' : 'grayscale opacity-80'}`} />
                      )}
                      <div className={`
                        absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300
                        ${isSelected ? 'bg-accent scale-100 shadow-neu-icon' : 'bg-transparent scale-0'}
                      `}>
                        <FiCheck size={10} className="text-white" />
                      </div>
                    </div>

                    <div className="flex-1">
                      <h4 className={`text-sm font-bold transition-colors ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
                        {user.name}
                      </h4>
                      <p className="text-xs text-text-secondary font-mono">@{user.username}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 min-h-[40px]">
          {selectedUsers.map(user => (
            <div key={user.id} className="flex items-center bg-accent text-accent-foreground rounded-full px-3 py-1 text-sm font-medium">
              <span>{user.name}</span>
              <button onClick={() => handleRemoveUser(user.id)} className="ml-2 text-accent-foreground/70 hover:text-accent-foreground font-bold">
                &times;
              </button>
            </div>
          ))}
        </div>
      </div>
    </ModalBase>
  );
}
