import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContactRecord, MinimalProfile, UserId } from '@nyx/shared';
import { getParticipantUserId } from '@nyx/shared';
import { useAuthStore } from '@store/auth';
import { useConversationStore } from '@store/conversation';
import { useVerificationStore } from '@store/verification';
import { useProfileStore, hydrateProfileForPlainId } from '@store/profile';
import { subscribeToContacts, getAllContacts } from '@lib/contactStore';
import {
  compareByTrustDescThenRecency,
  computeContactTrust,
  type ContactTrustLevel,
} from '@lib/contactTrust';
import { toAbsoluteUrl } from '@utils/url';
import DefaultAvatar from '@/components/ui/DefaultAvatar';
import { FiCheck, FiShield, FiUserCheck } from 'react-icons/fi';

export type PickableContact = ContactRecord & { trust: ContactTrustLevel };

/**
 * [CONTACT PICKER 2026-11-26] Sumber tunggal untuk "user yang boleh dipilih
 * ke grup": contact store (persisten, survive reinstall), bukan hasil
 * pencarian username. Blocked dan diri sendiri selalu disaring; trust
 * diverifikasi dari conversation 1:1 sehingga verified tampil lebih dulu.
 *
 * Create Group dan Add Participant memakai hook ini — jangan menambah jalur
 * search username baru di modal anggota, karena itu membuka penambahan orang
 * yang belum pernah berinteraksi (di luar kontak).
 */
export function usePickableContacts(): PickableContact[] {
  const me = useAuthStore(s => s.user);
  const [contacts, setContacts] = useState<PickableContact[]>([]);

  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      try {
        const all = await getAllContacts();
        const { verifiedStatus } = useVerificationStore.getState();
        const conversations = useConversationStore.getState().conversations;
        const verifiedPeers = new Set<string>();
        for (const conversation of conversations) {
          if (conversation.isGroup || !verifiedStatus[conversation.id]) continue;
          const peer = conversation.participants.find(
            participant => String(getParticipantUserId(participant)) !== String(me?.id),
          );
          if (peer) verifiedPeers.add(String(peer.id));
        }
        const blocked = new Set(useAuthStore.getState().blockedUserIds);
        const withTrust = all
          .filter(contact => String(contact.userId) !== String(me?.id) && !blocked.has(contact.userId))
          .map(contact => ({
            ...contact,
            trust: computeContactTrust({
              inContacts: true,
              isVerified: verifiedPeers.has(contact.userId),
              blocked: blocked.has(contact.userId),
            }),
          }))
          .sort(compareByTrustDescThenRecency);
        if (!cancelled) setContacts(withTrust);
      } catch {
        // Contact store tidak tersedia (vault terkunci / storage error):
        // picker kosong, bukan crash. Pemanggil tetap bisa menampilkan state kosong.
      }
    };
    void reload();
    const unsubscribe = subscribeToContacts(() => void reload());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [me?.id]);

  return contacts;
}

export function ContactRow({
  contact,
  isSelected,
  isExisting = false,
  onSelect,
}: {
  contact: PickableContact;
  isSelected: boolean;
  /** Sudah menjadi anggota grup; baris nonaktif dan diberi label. */
  isExisting?: boolean;
  onSelect: (profile: MinimalProfile) => void;
}) {
  const { t } = useTranslation(['common', 'modals']);
  const uid = String(contact.userId);
  // Baca key komposit dulu, lalu alias plain-id: profil yang didekripsi jalur
  // mana pun (pesan/prefetch/kontak lain) selalu dual-write ke alias.
  const profile = useProfileStore(state => {
    const composite = contact.encryptedProfile
      ? `${uid}_${contact.encryptedProfile.substring(0, 32)}`
      : uid;
    return state.profiles[composite] ?? state.profiles[uid];
  });

  useEffect(() => {
    if (profile) return;
    if (contact.encryptedProfile) {
      void useProfileStore.getState().decryptAndCache(contact.userId, contact.encryptedProfile);
    } else {
      void hydrateProfileForPlainId(contact.userId);
    }
  }, [contact.userId, contact.encryptedProfile, profile]);

  const name = profile?.name || contact.alias || '';
  const avatarUrl = profile?.avatarUrl || undefined;
  const select = () =>
    onSelect({
      id: contact.userId as unknown as UserId,
      name,
      username: profile?.username || '',
      avatarUrl: avatarUrl ?? null,
    });

  return (
    <button
      type="button"
      disabled={isExisting}
      aria-pressed={isSelected}
      onClick={select}
      className={`
        w-full text-left relative flex items-center gap-4 p-3 rounded-xl transition-all duration-300
        border border-transparent
        bg-bg-main shadow-[5px_5px_10px_rgba(0,0,0,0.1),-5px_-5px_10px_rgba(255,255,255,0.8)] dark:shadow-[4px_4px_8px_rgba(0,0,0,0.4),-4px_-4px_8px_rgba(255,255,255,0.03)]
        ${isExisting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:-translate-y-0.5'}
      `}
    >
      <div className="relative">
        {avatarUrl ? (
          <img
            src={toAbsoluteUrl(avatarUrl)}
            className={`w-10 h-10 rounded-full object-cover transition-all ${isSelected ? 'grayscale-0' : 'grayscale opacity-80'}`}
            alt={name}
          />
        ) : (
          <DefaultAvatar
            name={name}
            id={uid}
            className={`w-10 h-10 transition-all ${isSelected ? 'grayscale-0' : 'grayscale opacity-80'}`}
          />
        )}
        <div
          className={`
            absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center transition-all duration-300
            ${isSelected ? 'bg-accent scale-100 shadow-neu-icon' : 'bg-transparent scale-0'}
          `}
        >
          <FiCheck size={10} className="text-white" aria-hidden="true" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <h4 className={`text-sm font-bold truncate transition-colors ${isSelected ? 'text-accent' : 'text-text-primary'}`}>
          {name || t('common:defaults.anonymous', 'Anonymous')}
        </h4>
        {profile?.username && (
          <p className="text-xs text-text-secondary font-mono truncate">@{profile.username}</p>
        )}
        {isExisting && (
          <p className="text-xs text-text-secondary mt-0.5">{t('modals:add_participant.already_member')}</p>
        )}
      </div>
      <span
        title={contact.trust === 'verified' ? t('common:contact_trust_verified') : t('common:contact_trust_known')}
        className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full shrink-0 ${
          contact.trust === 'verified'
            ? 'text-green-600 bg-green-500/10 dark:text-green-400'
            : 'text-text-secondary bg-black/5 dark:bg-white/5'
        }`}
      >
        {contact.trust === 'verified' ? (
          <FiShield size={10} aria-hidden="true" />
        ) : (
          <FiUserCheck size={10} aria-hidden="true" />
        )}
        {contact.trust === 'verified'
          ? t('common:contact_trust_verified')
          : t('common:contact_trust_known')}
      </span>
    </button>
  );
}
