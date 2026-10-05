import DefaultAvatar from '@/components/ui/DefaultAvatar';
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
import type { ConversationId, GroupRole } from '@nyx/shared';
import { parseGroupMembers } from '@nyx/shared';
import { getGroupMembers } from '@lib/groupPseudonyms';
import { useEffect } from 'react';
import { useProfileStore, hydrateProfileForPlainId } from '@store/profile';
import { useTranslation } from 'react-i18next';

// [FIX UI ANONYMOUS 2026-10-05] Anggota yang gagal di-resolve (tanpa
// profileKey + remote tak membantu) ditandai sekali per sesi — jangan boros
// GET /api/users/:id tiap kali panel grup dibuka.
const prefetchFailed = new Set<string>();

const ParticipantActions = ({ conversationId, participant, profile, amIAdmin, myRole }: { conversationId: ConversationId, participant: Participant, profile: DecryptedProfile, amIAdmin: boolean, myRole?: GroupRole }) => {
  const { t } = useTranslation(['modals', 'common']);
  const [isOpen, setIsOpen] = useState(false);
  const { user, blockUser, unblockUser, blockedUserIds } = useAuthStore(useShallow(s => ({
    user: s.user, blockUser: s.blockUser, unblockUser: s.unblockUser, blockedUserIds: s.blockedUserIds
  })));
  const showConfirm = useModalStore(s => s.showConfirm);

  if (user?.id === participant.id) {
    return null;
  }

  const isBlocked = blockedUserIds.includes(participant.id);

  const handleRoleChange = async (newRole: 'ADMIN' | 'MEMBER') => {
    setIsOpen(false);
    try {
      const { useConversationStore } = await import('@store/conversation');
      const { encryptGroupMetadata } = await import('@utils/crypto');
      const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
      const meta = conv?.decryptedMetadata as { v?: number; authSecret?: string; members?: unknown; generation?: number } | undefined;
      if (!conv || !meta || meta.v !== 3 || !meta.authSecret) {
        throw new Error('Roster unavailable (metadata v3 not decrypted)');
      }
      // [T4] Role change = mutasi roster di metadata (server hanya menerima
      // blob terenkripsi + blind auth — tidak tahu role siapa pun).
      const members = parseGroupMembers(meta.members).map(m =>
        m.userId === participant.id ? { ...m, role: newRole } : m
      );
      if (!members.some(m => m.userId === participant.id)) throw new Error('Member not in roster');
      const encryptedMetadata = await encryptGroupMetadata({
        ...(meta as object),
        members,
      } as Parameters<typeof encryptGroupMetadata>[0], conversationId);
      const { useAuthStore } = await import('@store/auth');
      const { getMyAdminToken } = await import('@lib/groupPseudonyms');
      const meId = useAuthStore.getState().user?.id;
      const targets = conv.participants.filter(p => p.id !== meId).map(p => p.id);
      await api(`/api/conversations/${conversationId}/details`, {
        method: 'PUT',
        headers: {
          'X-Group-Token': meta.authSecret,
          // [26.9 RBAC] Mutasi roster = operasi admin (guard server-side).
          'X-Admin-Token': getMyAdminToken(conversationId) ?? '',
        },
        body: JSON.stringify({ encryptedMetadata, targetRecipients: targets }),
      });
      useConversationStore.getState().updateParticipantRole(conversationId, participant.id, newRole);
      // [26.9 RBAC] Promosi MEMBER→ADMIN/OWNER → seal admin capability token
      // ke penerima (pairwise opaque; server hanya relay). Fire-and-forget.
      if (newRole === 'ADMIN') {
        import('@utils/crypto').then(({ distributeAdminToken }) =>
          distributeAdminToken(conversationId, participant.id).catch(e =>
            console.warn('[RBAC] Failed to distribute admin token on promote:', e))
        );
      }
      toast.success(t('modals:participants.toasts.role_changed', { name: profile.name, role: newRole.toLowerCase() }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('modals:participants.toasts.role_failed', { error: msg }));
    }
  };

  const handleRemove = () => {
    setIsOpen(false);
    showConfirm(
      t('modals:participants.remove_title'),
      t('modals:participants.remove_desc', { name: profile.name }),
      async () => {
        try {
          const { useConversationStore } = await import('@store/conversation');
          const conv = useConversationStore.getState().conversations.find(c => c.id === conversationId);
          // [26.8.1] Blind auth: kick = mutasi grup, wajib X-Group-Token.
          const groupToken = (conv?.decryptedMetadata as { authSecret?: string } | undefined)?.authSecret;
          if (!groupToken) throw new Error('Group token unavailable (metadata not decrypted)');
          const removeRecipients = conv?.participants?.filter(p => p.id !== participant.id)?.map(p => p.id) || [];
          await api(`/api/conversations/${conversationId}/participants/${participant.id}`, {
            method: 'DELETE',
            headers: { 'X-Group-Token': groupToken },
            body: JSON.stringify({ targetRecipients: removeRecipients }),
          });
          // [T4 RACE FIX] Hapus dari store SEKARANG (jangan tunggu event socket
          //): rotateGroupKey di bawah membaca participants store — kalau
          // kicked member masih ada di store saat rotasi, metadata v3 baru
          // terenkripsi DENGAN dia masih di roster (bug: kicked user tetap
          // "Already a member" di modal add setelah kick).
          useConversationStore.getState().removeParticipant(conversationId, participant.id);
          // [T1 FIX 2026-09-28] Rotasi AKTIF oleh admin: hapus kicked member
          // dari metadata (peta baru, generation+1) + distribusikan kunci era
          // baru SEKARANG — kicked member tak bisa mengikuti era kunci baru.
          // (Sebelumnya hanya lazy: menunggu tiap member kirim pesan.)
          try {
            const { rotateGroupKey } = await import('@utils/crypto');
            await rotateGroupKey(conversationId, 'membership_change', true);
          } catch (rotErr) {
            console.warn('[T1] Active rotation after kick failed (will retry lazily):', rotErr);
          }
          toast.success(t('modals:participants.toasts.removed', { name: profile.name }));
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : t('common:errors.unknown');
          toast.error(t('modals:participants.toasts.remove_failed', { error: msg }));
        }
      }
    );
  };

  const handleBlockToggle = async () => {
    setIsOpen(false);
    try {
      if (isBlocked) {
        await unblockUser(participant.id);
        toast.success(t('modals:participants.toasts.unblocked', { name: profile.name }));
      } else {
        await blockUser(participant.id);
        toast.success(t('modals:participants.toasts.blocked', { name: profile.name }));
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
        toast.error(t('modals:participants.toasts.block_failed', { error: msg }));
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
            {/* [T4 v3] Hierarki: OWNER tak bisa diubah role-nya; ADMIN boleh
                promote MEMBER→ADMIN & demote ADMIN→MEMBER; hanya OWNER yang
                boleh kick admin lain. */}
            {amIAdmin && myRole !== 'ADMIN' && participant.role === 'MEMBER' && (
              <li><button onClick={() => handleRoleChange('ADMIN')} className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-bg-surface">{t('modals:participants.make_admin')}</button></li>
            )}
            {amIAdmin && myRole !== 'ADMIN' && participant.role === 'ADMIN' && user?.id !== participant.id && (
              <li><button onClick={() => handleRoleChange('MEMBER')} className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-bg-surface">{t('modals:participants.dismiss_admin')}</button></li>
            )}
            {amIAdmin && user?.id !== participant.id && (String(participant.role).toUpperCase() !== 'OWNER' && !(String(participant.role).toUpperCase() === 'ADMIN' && myRole === 'ADMIN')) && (
              <li><button onClick={handleRemove} className="w-full text-left px-4 py-2 text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground">{t('modals:participants.remove')}</button></li>
            )}
            <li><button onClick={handleBlockToggle} className={`w-full text-left px-4 py-2 text-sm ${isBlocked ? 'text-green-500 hover:bg-green-500/10' : 'text-destructive hover:bg-destructive/10'}`}>
              {isBlocked ? t('modals:participants.unblock') : t('modals:participants.block')}
            </button></li>
          </ul>
        </div>
      )}
    </div>
  );
};

const ROLE_LABEL_KEY: Record<string, string> = {
  OWNER: 'modals:participants.owner_role',
  ADMIN: 'modals:participants.admin_role',
  MEMBER: 'modals:participants.member_role',
};

const ParticipantItem = ({ p, conversationId, amIAdmin, myRole, handleProfileClick }: { p: Participant, conversationId: ConversationId, amIAdmin: boolean, myRole?: GroupRole, handleProfileClick: (p: Participant) => void }) => {
  const profile = useUserProfile(p);
  const { t } = useTranslation(['modals', 'common']);
  return (
    <li className="flex items-center justify-between p-2 rounded-lg hover:bg-secondary">
      <button onClick={() => handleProfileClick(p)} className="flex items-center gap-3 text-left min-w-0">
        {profile.avatarUrl ? (
          <img
            src={toAbsoluteUrl(profile.avatarUrl)}
            alt={profile.name || t('common:defaults.user')}
            className="w-10 h-10 rounded-full object-cover bg-bg-primary flex-shrink-0"
          />
        ) : (
          <DefaultAvatar name={profile.name || t('common:defaults.user')} id={p.id} className="w-10 h-10 bg-bg-primary flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text-primary truncate">{profile.name || t('common:defaults.user')}</p>
          <p className="text-xs text-text-secondary truncate">{profile.description || t('modals:group_info.no_desc')}</p>
          {String(p.role).toUpperCase() !== 'MEMBER' && (
            <p className="text-xs text-accent-color">{t(ROLE_LABEL_KEY[p.role] ?? 'modals:participants.member_role', String(p.role))}</p>
          )}
        </div>
      </button>
      <ParticipantActions conversationId={conversationId} participant={p} profile={profile} amIAdmin={amIAdmin} myRole={myRole} />
    </li>
  );
};

const ParticipantList = ({ conversationId, participants, amIAdmin }: { conversationId: ConversationId, participants: Participant[], amIAdmin: boolean }) => {
  const openProfileModal = useModalStore(s => s.openProfileModal);
  const myId = useAuthStore.getState().user?.id;
  const myRole = getGroupMembers(conversationId)?.find(m => m.userId === myId)?.role;

  // [T4] Prefetch profil anggota (GET /api/users/:id → encryptedProfile,
  // didekripsi dengan profileKey dari pesan bila tersedia).
  // [FIX UI ANONYMOUS 2026-10-05] Rantai hidrasi per anggota: RAM/IDB keyed
  // polos → dekripsi ep lokal (bila ada) → remote → dekripsi ep remote →
  // tandai gagal sekali per sesi. Dulu: hasil dekripsi TIDAK PERNAH terlihat
  // oleh useUserProfile (mismatch key komposit vs polos) dan remote diulang
  // tiap mount → "Anonymous" permanen tanpa error console.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const p of participants) {
        if (cancelled) break;
        const uid = String(p.id);
        const ep = p.encryptedProfile ?? null;
        const cached = await useProfileStore.getState().getCacheOnly(p.id, ep);
        if (cached) continue;
        const hydrated = await hydrateProfileForPlainId(p.id, ep);
        if (hydrated?.name && hydrated.name !== 'Encrypted User') continue;
        if (prefetchFailed.has(uid)) continue;
        try {
          const remote = await api<{ encryptedProfile?: string | null }>(`/api/users/${uid}`);
          if (cancelled) return;
          if (remote?.encryptedProfile) {
            const dec = await useProfileStore.getState().decryptAndCache(p.id, remote.encryptedProfile);
            if (dec?.name && dec.name !== 'Encrypted User') continue;
          }
          prefetchFailed.add(uid); // remote tak membantu (profil terkunci kunci)
        } catch {
          prefetchFailed.add(uid); // offline / 404 — jangan diulang sesi ini
        }
      }
    })();
    return () => { cancelled = true; };
  }, [participants]);

  const handleProfileClick = (participant: Participant) => {
    openProfileModal(participant.id);
  };

  return (
    <ul className="space-y-2">
      {participants.map(p => (
        <ParticipantItem key={p.id} p={p} conversationId={conversationId} amIAdmin={amIAdmin} myRole={myRole} handleProfileClick={handleProfileClick} />
      ))}
    </ul>
  );
};

export default ParticipantList;
