import DefaultAvatar from '@/components/ui/DefaultAvatar';
import { useState, useRef, useEffect } from 'react';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useShallow } from 'zustand/react/shallow';
import ParticipantList from './ParticipantList';
import EditGroupInfoModal from './EditGroupInfoModal';
import AddParticipantModal from './AddParticipantModal';
import { api } from '@lib/api';
import toast from 'react-hot-toast';
import { toAbsoluteUrl } from '@utils/url';
import { FiEdit2, FiLogOut, FiPlus, FiX, FiLock } from 'react-icons/fi';
import { useGlobalEscape } from '../hooks/useGlobalEscape';
import { amIGroupAdmin, getGroupMembers } from '@lib/groupPseudonyms';
import { useModalStore } from '@store/modal';
import MediaGallery from './MediaGallery';
import { motion, AnimatePresence } from 'framer-motion';
import { AnimatedTabs } from './ui/AnimatedTabs';
import { uploadToR2 } from '@lib/r2';
import { compressImage } from '@lib/fileUtils';
import ImageCropperModal from './ImageCropperModal';
import type { ConversationId, GroupMemberEntry } from '@nyx/shared';
import { parseGroupMembers } from '@nyx/shared';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '@store/settings';
import { estimateDailyCoverBytes } from '@lib/coverTraffic';
import clsx from 'clsx';

// [T4] Cover traffic (26.10.5): per-group opt-in, client-local state.
// Master kill-switch hidup di global Settings, bukan di sini.
// [26.10.5] Bundle "Maximum" — satu switch: cover traffic + ephemeral receipts
// (batched/jittered release menyusul). Semua state client-local.
const CoverTrafficCard = ({ conversationId }: { conversationId: ConversationId }) => {
  const { t } = useTranslation(['modals']);
  const { maximum, masterEnabled, ephemeral } = useSettingsStore(useShallow((s) => ({
    maximum: s.coverTrafficMaximumGroups.includes(conversationId),
    masterEnabled: s.coverTrafficMasterEnabled,
    ephemeral: s.ephemeralReceiptsGroups.includes(conversationId),
  })));
  const dailyMb = (estimateDailyCoverBytes() / (1024 * 1024)).toFixed(1);

  const handleToggle = (enabled: boolean) => {
    const settings = useSettingsStore.getState();
    // Bundle: cover + ephemeral receipts selalu bersama (satu privacy level).
    settings.setGroupCoverTraffic(conversationId, enabled);
    settings.setGroupEphemeralReceipts(conversationId, enabled);
    import('@lib/coverTraffic').then(({ getCoverScheduler }) => {
      const scheduler = getCoverScheduler();
      scheduler.updatePreferences({
        masterEnabled: settings.coverTrafficMasterEnabled,
        maximumGroups: new Set(settings.coverTrafficMaximumGroups),
      });
      scheduler.sync(settings.coverTrafficMaximumGroups);
    }).catch(() => {});
    toast.success(enabled
      ? t('modals:group_info.cover.enabled_toast', { mb: dailyMb })
      : t('modals:group_info.cover.disabled_toast'));
  };

  const isOn = maximum && masterEnabled;

  return (
    <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-6">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-lg font-semibold text-text-primary">{t('modals:group_info.cover.title')}</h4>
          <p className="text-sm text-text-secondary mt-1">
            {masterEnabled
              ? t('modals:group_info.cover.description', { mb: dailyMb })
              : t('modals:group_info.cover.disabled_by_master')}
          </p>
          {/* [26.10.5] Rincian bundle — dua fitur yang ikut switch ini */}
          <ul className="mt-3 space-y-1 text-xs text-text-secondary">
            <li className={clsx('flex items-center gap-2', isOn && 'text-text-primary')}>
              <span className={clsx('w-1.5 h-1.5 rounded-full', isOn ? 'bg-emerald-500' : 'bg-gray-500')} />
              {t('modals:group_info.cover.bundle_cover')}
            </li>
            <li className={clsx('flex items-center gap-2', isOn && ephemeral && 'text-text-primary')}>
              <span className={clsx('w-1.5 h-1.5 rounded-full', isOn && ephemeral ? 'bg-emerald-500' : 'bg-gray-500')} />
              {t('modals:group_info.cover.bundle_ephemeral')}
            </li>
          </ul>
        </div>
        <button
          role="switch"
          aria-checked={isOn}
          disabled={!masterEnabled}
          onClick={() => handleToggle(!maximum)}
          className={clsx(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ml-4',
            isOn ? 'bg-accent-color' : 'bg-bg-tertiary',
            !masterEnabled && 'opacity-50 cursor-not-allowed'
          )}
        >
          <span className={clsx(
            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
            isOn ? 'translate-x-6' : 'translate-x-1'
          )} />
        </button>
      </div>
    </div>
  );
};

const GroupInfoPanel = ({ conversationId, onClose }: { conversationId: ConversationId; onClose: () => void; }) => {
  const { t } = useTranslation(['modals', 'common']);
  const { conversation } = useConversationStore(useShallow(state => ({
    conversation: state.conversations.find(c => c.id === conversationId),
  })));
  const { user } = useAuthStore(useShallow(s => ({ user: s.user })));
  const showConfirm = useModalStore(s => s.showConfirm);

  const [isEditing, setIsEditing] = useState(false);
  const [isAddParticipantModalOpen, setIsAddParticipantModalOpen] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('details'); 
  const [avatarCropTarget, setAvatarCropTarget] = useState<{ url: string, file: File } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tabs = [
    { id: 'details', label: t('modals:group_info.tabs.details') },
    { id: 'media', label: t('modals:group_info.tabs.media') },
  ];

  useEffect(() => {
    const timer = setTimeout(() => setIsPanelOpen(true), 10);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (avatarCropTarget?.url) {
        URL.revokeObjectURL(avatarCropTarget.url);
      }
    };
  }, [avatarCropTarget]);

  const handleClose = () => {
    setIsPanelOpen(false);
    setTimeout(onClose, 300);
  };

  useGlobalEscape(handleClose);

  // [T4 ROSTER SYNC] Metadata v3 = sumber kebenaran roster. Mirror ke
  // participants store SEKALI per mount panel (dan saat metadata berubah) —
  // bila roster metadata lebih baru dari mirror store, store di-update.
  // Ini memperbaiki: creator tidak terdeteksi sebagai admin (mirror lama
  // tidak pernah mengenal role OWNER) dan roster kosong/track saat v3.
  const metaV3Members = conversation?.decryptedMetadata?.v === 3
    ? conversation.decryptedMetadata.members
    : undefined;
  useEffect(() => {
    if (!conversation || !metaV3Members || metaV3Members.length === 0) return;
    const storeIds = new Set<string>(conversation.participants.map(p => p.id as string));
    const metaIds = new Set(metaV3Members.map(m => m.userId));
    const needsSync =
      storeIds.size !== metaIds.size ||
      metaV3Members.some(m => !storeIds.has(m.userId));
    if (!needsSync) return;
    useConversationStore.getState().syncParticipantsFromMetadata(conversationId, metaV3Members);
  }, [conversationId, metaV3Members]);

  if (!conversation || !conversation.isGroup) {
    return null;
  }

  // [T4] Admin check dari roster metadata v3 (fallback legacy v1/v2 via
  // participants). OWNER dan ADMIN sama-sama boleh mengelola grup.
  const amIAdmin = amIGroupAdmin(conversation.id);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;
    const file = e.target.files[0];
    setAvatarCropTarget({ url: URL.createObjectURL(file), file });
    e.target.value = '';
  };

  const handleUploadCroppedAvatar = async (croppedFile: File) => {
    const toastId = toast.loading(t('modals:group_info.toasts.processing_avatar'));

    try {
      let fileToUpload = croppedFile;
      try {
        if (croppedFile.type.startsWith('image/')) {
           fileToUpload = await compressImage(croppedFile);
        }
      } catch (err) {
        // Fallback
      }

      toast.loading(t('modals:group_info.toasts.uploading'), { id: toastId });
      
      const fileUrl = await uploadToR2(fileToUpload, 'groups', (progress) => {
         // Opsional: update progress toast
      });

      toast.loading(t('modals:group_info.toasts.updating'), { id: toastId });
      
      // [FIX] ZERO-KNOWLEDGE METADATA UPDATE
      const { encryptGroupMetadata, ensureGroupSession } = await import('@utils/crypto');
      const { emitGroupKeyDistribution } = await import('@lib/transportClient');

      // Ensure session exists
      const distributionKeys = await ensureGroupSession(conversation.id, conversation.participants);
      if (distributionKeys && distributionKeys.length > 0) {
        await emitGroupKeyDistribution(conversation.id, distributionKeys as { userId: string; key: string }[]);
      }

      const currentMetadata = conversation.decryptedMetadata || {};
      const newMetadata = { ...currentMetadata, avatarUrl: fileUrl };
      const encryptedMetadata = await encryptGroupMetadata(newMetadata, conversation.id);

      const avatarRecipients = conversation.participants?.filter(p => p.id !== user?.id)?.map(p => p.id) || [];
      await api(`/api/conversations/${conversation.id}/details`, {
        method: 'PUT',
        body: JSON.stringify({ encryptedMetadata, targetRecipients: avatarRecipients }),
      });

      toast.success(t('modals:group_info.toasts.avatar_updated'), { id: toastId });
      setAvatarCropTarget(null);
    } catch (error: unknown) {
      console.error('Avatar upload failed');
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('modals:group_info.toasts.upload_failed', { error: msg }), { id: toastId });
      setAvatarCropTarget(null);
    }
  };

  const handleForceRotateKeys = async () => {
    const toastId = toast.loading(t('modals:group_info.toasts.rotating_keys'));
    try {
      // [T1 FIX 2026-09-28] Rotasi manual = rotasi aktif penuh: peta pseudonym
      // baru (generation+1) + metadata re-encrypt + distribusi kunci era baru
      // (semua di dalam rotateGroupKey, urutan peta-dulu-lalu-kunci).
      const { rotateGroupKey } = await import('@utils/crypto');
      await rotateGroupKey(conversation.id, 'membership_change', true);
      toast.success(t('modals:group_info.toasts.keys_rotated'), { id: toastId });
      // Catatan: header X-Admin-Token dikirim di dalam rotateGroupKey →
      // POST /:id/key-rotation (guard server-side RBAC).
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('modals:group_info.toasts.rotate_failed', { error: msg }), { id: toastId });
    }
  };

  // [26.9] Pilih penerus ownership: anggota paling awal gabung
  // (joinedAtGeneration terkecil; tie-break userId deterministik).
  const pickOwnershipSuccessor = (excludeId: string): GroupMemberEntry | undefined => {
    return (getGroupMembers(conversation.id) || [])
      .filter(m => m.userId !== excludeId)
      .sort((a, b) => (a.joinedAtGeneration - b.joinedAtGeneration) || a.userId.localeCompare(b.userId))[0];
  };

  const performLeave = async (deleteGroup: boolean) => {
    const toastId = toast.loading(t('modals:group_info.toasts.leaving'));
    try {
      // [26.8.1] Blind auth: leave = mutasi grup, wajib bukti tau authSecret
      // (X-Group-Token dari metadata ter-dekripsi) — bukti keanggotaan tanpa
      // membocorkan roster ke server.
      // [BUGFIX 2026-10-02] Metadata belum ter-decrypt TIDAK lagi memblokir
      // leave: server kini menerima leave via baris delivery-token milik sendiri
      // (bukti keanggotaan yang sudah ada di server, tidak bocor apa pun baru).
      // Token tetap dikirim bila tersedia; owner-transfer butuh metadata —
      // dilewati bila tidak ada (penerus dipromosikan oleh admin lain / creator).
      const groupToken = (conversation.decryptedMetadata as { authSecret?: string } | undefined)?.authSecret;
      const leaveRecipients = conversation.participants?.filter(p => p.id !== user?.id)?.map(p => p.id) || [];

      // [26.9 OWNER TRANSFER] Owner keluar saat masih ada anggota lain →
      // promote penerus (paling awal gabung) jadi OWNER DI METADATA v3 sebelum
      // leave: re-encrypt roster (generation+1, peta pseudonym baru tanpa saya)
      // + PUT details. Grup tidak pernah tanpa owner.
      const meta = conversation.decryptedMetadata as { v?: number; members?: unknown } | undefined;
      const myId = user?.id;
      if (!deleteGroup && myId && meta?.v === 3 && groupToken
          && getGroupMembers(conversation.id)?.find(m => m.userId === myId)?.role === 'OWNER'
          && leaveRecipients.length > 0) {
        const remaining = parseGroupMembers(meta.members).filter(m => m.userId !== myId);
        const successor = pickOwnershipSuccessor(myId);
        const newMembers = remaining.map(m =>
          m.userId === successor?.userId ? { ...m, role: 'OWNER' as const } : m
        );
        const { encryptGroupMetadata, distributeAdminToken } = await import('@utils/crypto');
        const { getMyAdminToken } = await import('@lib/groupPseudonyms');
        const encryptedMetadata = await encryptGroupMetadata({
          ...(meta as object),
          participants: leaveRecipients,
          members: newMembers,
        } as Parameters<typeof encryptGroupMetadata>[0], conversation.id);
        await api(`/api/conversations/${conversation.id}/details`, {
          method: 'PUT',
          headers: {
            'X-Group-Token': groupToken,
            // [26.9 RBAC] Mutasi roster = operasi admin (guard server-side).
            'X-Admin-Token': getMyAdminToken(conversation.id) ?? '',
          },
          body: JSON.stringify({ encryptedMetadata, targetRecipients: leaveRecipients }),
        });
        // [26.9 RBAC] Owner keluar → penerus WAJIB menerima admin capability
        // token sebelum leave (seandainya gagal, leave tetap jalan — token bisa
        // di-issue ulang oleh admin lain / creator via re-seal).
        if (successor) {
          await distributeAdminToken(conversation.id, successor.userId).catch(e =>
            console.warn('[RBAC] Failed to transfer admin token on owner leave:', e));
        }
      }

      await api(`/api/conversations/${conversation.id}/leave`, {
        method: 'DELETE',
        // [BUGFIX 2026-10-02] X-Group-Token opsional — tanpa metadata, server
        // menerima via delivery-token proof (lihat routes/conversations.ts).
        headers: groupToken ? { 'X-Group-Token': groupToken } : undefined,
        body: JSON.stringify({ targetRecipients: leaveRecipients }),
      });

      // [26.9 SOLO-LEAVE] Anggota terakhir keluar → grup dihapus permanen di
      // server (guard server: nol delivery token tersisa → purge cascade).
      if (deleteGroup) {
        const { getMyAdminToken } = await import('@lib/groupPseudonyms');
        await api(`/api/conversations/${conversation.id}/group`, {
          method: 'DELETE',
          headers: {
            ...(groupToken ? { 'X-Group-Token': groupToken } : {}),
            // [26.9 RBAC] Purge = operasi admin (guard server-side).
            'X-Admin-Token': getMyAdminToken(conversation.id) ?? '',
          },
        });
        useConversationStore.getState().removeConversation(conversation.id);
      }

      toast.success(t('modals:group_info.toasts.left_success'), { id: toastId });
      handleClose();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('modals:group_info.toasts.leave_failed', { error: msg }), { id: toastId });
    }
  };

  const handleLeaveGroup = () => {
    const others = conversation.participants?.filter(p => p.id !== user?.id) || [];

    // [26.9 RBAC + SOLO-LEAVE] Satu-satunya anggota → tidak ada yang bisa
    // melanjutkan grup. Konfirmasi eksplisit: keluar = grup DIHAPUS PERMANEN.
    // Hanya OWNER/ADMIN yang boleh menghapus grup — MEMBER solo hanya di-
    // beri tahu grup ditinggalkan tanpa dihapus (server menolak purge).
    if (others.length === 0) {
      if (amIGroupAdmin(conversation.id)) {
        showConfirm(
          t('modals:group_info.leave_solo_title'),
          t('modals:group_info.leave_solo_desc'),
          () => { void performLeave(true); },
          undefined,
          t('modals:group_info.leave_solo_confirm')
        );
      } else {
        showConfirm(
          t('modals:group_info.leave_solo_member_title'),
          t('modals:group_info.leave_solo_member_desc'),
          () => { void performLeave(false); }
        );
      }
      return;
    }

    // [26.9 OWNER TRANSFER] Info transfer otomatis di dialog konfirmasi —
    // tidak ada langkah tambahan untuk owner.
    const myRole = getGroupMembers(conversation.id)?.find(m => m.userId === user?.id)?.role;
    if (myRole === 'OWNER') {
      const successor = pickOwnershipSuccessor(user?.id || '');
      const successorName = others.find(p => p.id === successor?.userId)?.name
        || t('common:defaults.user');
      showConfirm(
        t('modals:group_info.leave_owner_title'),
        t('modals:group_info.leave_owner_desc', { name: successorName }),
        () => { void performLeave(false); }
      );
      return;
    }

    void performLeave(false);
  };

  const title = conversation.decryptedMetadata?.title || t('common:defaults.group_unknown', 'Unknown Group');
  const avatarSrc = conversation.decryptedMetadata?.avatarUrl 
    ? `${toAbsoluteUrl(conversation.decryptedMetadata.avatarUrl)}?t=${conversation.lastUpdated}` 
    : undefined;

  return (
    <div className="fixed inset-0 z-40">
      <div 
        className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${isPanelOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
        aria-hidden="true"
      ></div>

      <div className={`absolute top-0 right-0 h-full w-full max-w-md bg-bg-surface shadow-neumorphic-convex z-50 flex flex-col transition-transform duration-300 ease-in-out ${isPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <header className="p-4 flex items-center flex-shrink-0">
          <button onClick={handleClose} className="btn-flat p-2 rounded-full text-text-secondary mr-2">
            <FiX size={24} />
          </button>
          <h2 className="text-xl font-bold text-text-primary">{t('modals:group_info.title')}</h2>
        </header>

        <main className="flex-1 flex flex-col overflow-y-auto bg-bg-main">
          <div className="p-4 md:px-6 md:pt-6 flex-shrink-0">
            <AnimatedTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
          </div>

          <div className="flex-1 relative px-4 md:px-6 pb-6">
            <AnimatePresence mode="wait">
              {activeTab === 'details' && (
                <motion.div
                  key="group-details"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-6"
                >
                  {/* Group Identity Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex p-6 text-center relative">
                    <div className="relative w-24 h-24 mx-auto mb-4">
                      {avatarSrc ? (
                        <img
                          src={avatarSrc}
                          alt={title}
                          className="w-full h-full rounded-full object-cover bg-bg-primary"
                        />
                      ) : (
                        <DefaultAvatar name={title} id={conversation.id} className="w-full h-full bg-bg-primary" />
                      )}
                      {amIAdmin && (
                        <>
                          <button onClick={() => fileInputRef.current?.click()} className="absolute bottom-0 right-0 bg-accent-gradient rounded-full p-2 text-white hover:opacity-90" aria-label={t('modals:group_info.change_avatar')}>
                            <FiEdit2 size={16} />
                          </button>
                          <input type="file" ref={fileInputRef} onChange={handleAvatarChange} className="hidden" accept="image/*" />
                        </>
                      )}
                    </div>
                    <h3 className="text-2xl font-bold text-text-primary">{title}</h3>
                    <p className="text-text-secondary mt-1">{conversation.decryptedMetadata?.description || t('modals:group_info.no_desc')}</p>
                    {amIAdmin && (
                      <button onClick={() => setIsEditing(true)} className="absolute top-4 right-4 text-text-secondary hover:text-accent-color">
                        <FiEdit2 size={20} />
                      </button>
                    )}
                  </div>

                  {/* [T4] Privacy level — cover traffic toggle (client-local) */}
                  <CoverTrafficCard conversationId={conversation.id} />

                  {/* Members Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex">
                    <div className="p-6 border-b border-border">
                      <h4 className="text-lg font-semibold text-text-primary">{t('modals:group_info.member_count', { count: conversation.participants.length })}</h4>
                      {amIAdmin && (
                        <button
                          onClick={() => setIsAddParticipantModalOpen(true)}
                          className="w-full flex items-center justify-center p-3 mt-4 rounded-lg text-accent shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all"
                        >
                          <FiPlus className="mr-2" />
                          <span>{t('modals:group_info.add_participants')}</span>
                        </button>
                      )}
                    </div>
                    <ParticipantList conversationId={conversation.id} participants={conversation.participants} amIAdmin={amIAdmin} />
                  </div>

                  {/* Actions Card */}
                  <div className="bg-bg-surface rounded-xl shadow-neumorphic-convex flex flex-col">
                    {/* [26.9 RBAC] Rotasi kunci = operasi admin — hanya OWNER/ADMIN. */}
                    {amIAdmin && (
                      <button
                        onClick={handleForceRotateKeys}
                        className="w-full flex items-center justify-center p-4 font-semibold text-orange-500 shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all rounded-t-xl border-b border-border"
                      >
                        <FiLock className="mr-3" />
                        <span>{t('modals:group_info.toasts.rotate_button')}</span>
                      </button>
                    )}
                    <button
                      onClick={handleLeaveGroup}
                      className="w-full flex items-center justify-center p-4 font-semibold text-red-500 shadow-neumorphic-convex active:shadow-neumorphic-pressed transition-all rounded-b-xl"
                    >
                      <FiLogOut className="mr-3" />
                      <span>{t('modals:group_info.leave_group')}</span>
                    </button>
                  </div>
                </motion.div>
              )}

              {activeTab === 'media' && (
                <motion.div
                  key="group-media"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                >
                  <MediaGallery conversationId={conversation.id} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>

        {isEditing && (
          <EditGroupInfoModal
            conversationId={conversation.id}
            currentTitle={conversation.decryptedMetadata?.title || ''}
            currentDescription={conversation.decryptedMetadata?.description || null}
            onClose={() => setIsEditing(false)}
          />
        )}

        {isAddParticipantModalOpen && (
          <AddParticipantModal
            conversationId={conversation.id}
            onClose={() => setIsAddParticipantModalOpen(false)}
          />
        )}

        {avatarCropTarget && (
          <ImageCropperModal
            file={avatarCropTarget.file}
            url={avatarCropTarget.url}
            aspect={1}
            onClose={() => setAvatarCropTarget(null)}
            onSave={handleUploadCroppedAvatar}
          />
        )}
      </div>
    </div>
  );
};

export default GroupInfoPanel;
