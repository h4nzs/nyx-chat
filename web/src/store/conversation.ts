// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import { createWithEqualityFn } from "zustand/traditional";
import { api, authFetch } from "@lib/api";
import { transportClient, emitSessionKeyRequest, fireGhostSync, emitGroupKeyDistribution, emitMetadataUpdated } from '@lib/transportClient';
// NOTE: useMessageStore & decryptMessageObject di-import DINAMIS di dalam aksi
// untuk memutus circular dependency (message.ts ⇄ conversation.ts).
import { useVerificationStore } from './verification';
import { useAuthStore, User } from './auth';
import { asConversationId, asMessageId } from '@nyx/shared';
import type { ConversationId, UserId, MessageId, MessageStatus, RawServerMessage, Message, Participant, ConversationUi as Conversation, GroupMemberEntry } from '@nyx/shared';
import { asUserId, parseGroupMembers, getParticipantUserId } from '@nyx/shared';
// Removed all crypto imports
import toast from 'react-hot-toast';
import { captureAndLog } from '@utils/feedback';

import { encryptGroupMetadata, decryptGroupMetadata, forceRotateGroupSenderKey, generatePseudonymMap, getPseudonymMap } from "@utils/crypto";
import { generateDeliveryToken, findPseudonymInMap } from '@lib/groupPseudonyms';
// [docs/28 Tier 2 — B1/B3] perbandingan "pesan mana yang terbaru" harus
// sejalan dengan urutan tampilan (seq; pending = paling baru) — createdAt server
// kini kasar sehingga perbandingan waktu bisa salah nilai.
import { compareMessagesByOrder } from '@utils/messageOrder';
// [2026-10-18] Preview daftar chat: hanya pesan yang benar-benar terlihat
// (bukan pesan kontrol) yang boleh mengisi `lastMessage`.
import { isPreviewableMessage, pickPreviewLastMessage, withPreview } from '@utils/messagePreview';
import i18n from '../i18n';
export type { MessageStatus, RawServerMessage, Message, Participant, Conversation };

function getToastErrorMessage(error: unknown, i18nKey: string, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return i18n.t(i18nKey, fallback);
}

// --- Helper Functions ---

// [FIX #98] Watermark anti re-count: id pesan yang SUDAH pernah menaikkan
// unreadCount tidak boleh menaikkannya lagi dalam satu sesi UI. Tanpa ini,
// pesan yang sama bisa dihitung 2× (live event `message:new` diproses oleh
// socketListeners DAN doAddIncomingMessage) atau dihitung ulang saat pesan
// lama di-emit ulang (re-delivery/sync race, edit pesan lama) — itulah bug
// "unread count keep reappearing" setelah reload. In-memory saja memang
// sengaja: setelah reload, loadConversations mereset unreadCount ke 0 dulu.
const unreadCountedMessageIds = new Set<string>();
const UNREAD_WATERMARK_MAX = 500;

function markUnreadCounted(messageId: string): void {
  if (unreadCountedMessageIds.size >= UNREAD_WATERMARK_MAX) {
    // Hapus entri tertua (Set mempertahankan urutan insert).
    const oldest = unreadCountedMessageIds.values().next().value;
    if (oldest !== undefined) unreadCountedMessageIds.delete(oldest);
  }
  unreadCountedMessageIds.add(messageId);
}

const sortConversations = (list: Conversation[], currentUserId: string | undefined) =>
  [...list].sort((a, b) => {
    // First, sort by pinned status (pinned conversations first)
    const aIsPinned = a.participants.some(p => p.id === currentUserId && p.isPinned);
    const bIsPinned = b.participants.some(p => p.id === currentUserId && p.isPinned);

    if (aIsPinned && !bIsPinned) return -1;
    if (!aIsPinned && bIsPinned) return 1;

    // Then, sort by latest activity
    // [docs/28 Tier 2 — B3] `Message.createdAt` server kini kasar (bucket 15 mnt)
    // → pakai `sentAt` presisi bila ada; `createdAt` hanya fallback. Tie-break
    // deterministik per-conversation supaya urutan tidak flip saat seri bucket.
    const activity = (c: Conversation) => {
      const last = c.lastMessage;
      const precise = typeof last?.sentAt === 'number'
        ? last.sentAt
        : new Date(last?.createdAt || c.updatedAt || 0).getTime();
      return Number.isFinite(precise) ? precise : 0;
    };
    const diff = activity(b) - activity(a);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });

/**
 * Berapa baris vault yang diperiksa saat mencari preview. Baris terbaru bisa
 * berupa pesan kontrol (CALL_INIT/GHOST_SYNC/reaksi/unsend), jadi satu baris
 * saja tidak cukup — dan memindai seluruh riwayat jelas tidak perlu.
 */
const PREVIEW_SCAN_LIMIT = 30;

/**
 * Preview yang datang saat percakapan belum ada di store (pesan masuk lebih
 * awal dari `conversation:new`). Disimpan sementara lalu dipakai saat
 * percakapan itu muncul di `addOrUpdateConversation`/`loadConversations`,
 * supaya pesan pertama tidak sempat tampil sebagai "belum ada pesan".
 */
const pendingPreviews = new Map<string, Message>();
const PENDING_PREVIEW_MAX = 50;

function rememberPendingPreview(conversationId: string, message: Message): void {
  if (pendingPreviews.size >= PENDING_PREVIEW_MAX && !pendingPreviews.has(conversationId)) {
    const oldest = pendingPreviews.keys().next().value;
    if (oldest !== undefined) pendingPreviews.delete(oldest);
  }
  pendingPreviews.set(conversationId, withPreview(message));
}

function takePendingPreview(conversationId: string): Message | undefined {
  const pending = pendingPreviews.get(conversationId);
  if (pending) pendingPreviews.delete(conversationId);
  return pending;
}

// --- State Type ---

type State = {
  conversations: Conversation[];
  activeId: string | null;
  isSidebarOpen: boolean;
  error: string | null;
  loading: boolean;
  initialLoadCompleted: boolean;
};

type Actions = {
  loadConversations: () => Promise<void>;
  openConversation: (id: string | null) => void;
  deleteConversation: (id: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  toggleSidebar: () => void;
  startConversation: (peerId: string, optimisticProfile?: { name: string; username: string }) => Promise<ConversationId>;
  createGroup: (name: string, userIds: string[], avatarUrl?: string) => Promise<ConversationId>;
  searchUsers: (query: string) => Promise<{ id: string; encryptedProfile?: string | null; isVerified?: boolean; publicKey?: string }[]>;
  addOrUpdateConversation: (conversation: Conversation) => void;
  /**
   * Lepas percakapan dari daftar. `preserveHistory` (kick/removed) hanya
   * membuang record percakapan + state in-memory; pesan di ShadowVault dan
   * kunci grup (sender/receiver/skipped per era) DIPERTAHANKAN agar riwayat
   * tetap terbaca bila anggota di-add kembali (Opaque Mailbox: satu-satunya
   * salinan riwayat lokal ada di perangkat ini).
   */
  removeConversation: (conversationId: string, opts?: { preserveHistory?: boolean }) => void;
  updateConversation: (conversationId: string, updates: Partial<Conversation>) => Promise<void>;
  updateParticipantDetails: (user: Partial<User>) => void;
  addParticipants: (
    conversationId: string,
    participants: Participant[],
    // [BUGFIX 2026-10-18] Token delivery yang di-issue saat invite WAJIB ikut
    // metadata rotasi — sebelumnya hanya dikirim ke server, sehingga
    // buildTargetDeliveryTokens pada kiriman berikutnya memakai peta lama.
    opts?: { deliveryTokens?: Record<string, string> }
  ) => void;
  removeParticipant: (conversationId: string, userId: string) => void;
  updateParticipantRole: (conversationId: string, userId: string, role: "ADMIN" | "MEMBER") => void;
  syncParticipantsFromMetadata: (conversationId: string, members: GroupMemberEntry[]) => void;
  updateConversationLastMessage: (conversationId: string, message: Message) => void;
  forceConversationLastMessage: (conversationId: string, message: Message | null) => void;
  performHandshake: (conversationId: string) => Promise<void>;
  markKeyRotationNeeded: (conversationId: string, needed: boolean) => void;
  togglePinConversation: (conversationId: string) => Promise<void>;
  resyncState: () => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

// --- Zustand Store ---

const initialState: State = {
  conversations: [],
  activeId: null,
  isSidebarOpen: false,
  error: null,
  loading: false,
  initialLoadCompleted: false,
};

/**
 * [T3b] Bangun peta userId → delivery token untuk invite. Satu token acak
 * per anggota, di-issue creator dan didistribusikan via encrypted metadata
 * (anggota menemukan token miliknya setelah metadata ter-decrypt).
 */
const buildDeliveryTokensPayload = async (userIds: string[]): Promise<Record<string, string>> => {
  const map: Record<string, string> = {};
  for (const uid of userIds) {
    map[uid] = await generateDeliveryToken();
  }
  return map;
};

export const useConversationStore = createWithEqualityFn<State & Actions>((set, get) => ({
  ...initialState,

  clearError: () => set({ error: null }),

  reset: () => {
    set(initialState);
  },

  markKeyRotationNeeded: (id, needed) => set(s => ({ 
    conversations: s.conversations.map(c => c.id === id ? { ...c, requiresKeyRotation: needed } : c) 
  })),

  searchUsers: async (query) => {
    try {
      if (!query.trim()) return [];

      const trimmedQuery = query.trim();
      // [docs/35 Fase 4] Dua bentuk hash yang sah: 43-char (Argon2id klien) dan
      // 64-hex (blind index ter-pepper dari link lama). Bentuk 64-hex WAJIB
      // diteruskan apa adanya — kalau di-hash lagi, link lama tidak akan pernah
      // menemukan user dan tidak ada jalur migrasi.
      const isAlreadyHash =
        /^[A-Za-z0-9_-]{43}$/.test(trimmedQuery) || /^[a-f0-9]{64}$/i.test(trimmedQuery);

      const searchQuery = isAlreadyHash
        ? trimmedQuery
        : await import('@lib/crypto-worker-proxy').then(m => m.hashUsername(trimmedQuery));

      // [docs/35 Fase 3] Jalur tunggal: OHTTP bila aktif (`userSearch.ts`).
      const { searchUsersByHash } = await import('@lib/userSearch');
      const users = await searchUsersByHash(searchQuery);
      return users;
    } catch (error) {
      console.error("Failed to search users", error);
      throw error;
    }
  },

  resyncState: async () => {
    if (!get().initialLoadCompleted) {
      await get().loadConversations();
    }
  },

  loadConversations: async () => {
    let shouldProceed = false;
    set(state => {
      if (state.loading) return state;
      shouldProceed = true;
      return { ...state, loading: true, error: null };
    });
    if (!shouldProceed) return;

    try {
      const { shadowVault } = await import('@lib/shadowVaultDb');

      // 1. Get local conversations (participants stored client-side for Opaque Mailbox)
      const localConversations = await shadowVault.getAllConversations();
      const localIds = localConversations.map(c => c.id);

      // 2. Discovery ANONIM lewat token (docs/37 §37.3.3) + metadata by id.
      //    `POST /api/groups/sync` tidak memakai cookie/JWT: server hanya melihat
      //    hash token, tidak tahu akun mana yang memanggil. Jalur JWT
      //    (`/api/conversations/sync?ids=`) tetap dipakai untuk percakapan yang
      //    id-nya sudah kita miliki (1:1/metadata).
      let rawConversations: Conversation[] = [];
      const { collectMyDeliveryTokens, getMyGroupToken } = await import('@lib/groupPseudonyms');
      const myTokens = collectMyDeliveryTokens();
      if (myTokens.length > 0) {
        // [docs/37 §37.4 P3] Sync lewat OHTTP bila aktif, dengan bukti Privacy
        // Pass dari grup mana pun yang metadata-nya sudah ter-dekripsi.
        const { syncGroupMemberships } = await import('@lib/groupSync');
        const proofGroup = get().conversations.find(c => c.isGroup && getMyGroupToken(c.id));
        const sync = await syncGroupMemberships(myTokens.map(t => String(t)), {
          conversationId: proofGroup?.id,
        });
        rawConversations = Array.isArray(sync?.conversations) ? sync.conversations : [];
      }
      if (localIds.length > 0) {
        const byId = await api<Conversation[]>(`/api/conversations/sync?ids=${localIds.join(',')}`);
        if (Array.isArray(byId)) {
          const known = new Set(rawConversations.map(c => c.id));
          rawConversations = [...rawConversations, ...byId.filter(c => !known.has(c.id))];
        }
      }
      if (!Array.isArray(rawConversations)) throw new Error('Invalid data from server.');

      // If server returned discovered conversations, persist them locally
      if (localIds.length === 0 && rawConversations.length > 0) {
        for (const conv of rawConversations) {
          await shadowVault.saveConversation({ ...conv, participants: [], encryptionMode: 'SENDER_KEY' as const } as Conversation);
        }
      }

      // 3. Merge: server metadata + local participants
      const serverMap = new Map(rawConversations.map(c => [c.id, c]));
      const mergedSource = localConversations.map(local => {
        const server = serverMap.get(local.id);
        return { ...local, ...server, participants: local.participants, unreadCount: 0 };
      });
      // Also include server-only conversations (newly created on another device)
      for (const server of rawConversations) {
        if (!mergedSource.find(c => c.id === server.id)) {
          mergedSource.push({ ...server, participants: [], unreadCount: 0 } as Conversation);
        }
      }

      const conversations = await Promise.all(mergedSource.map(async c => {
        const participants = c.participants || [];

        // [2026-10-18] Ambil JENDELA baris terbaru, lalu pilih yang benar-benar
        // terlihat. Dulu hanya 1 baris: kalau baris terakhir itu pesan kontrol
        // (CALL_INIT/GHOST_SYNC/reaksi/tombstone) preview jadi kosong dan daftar
        // chat menampilkan "no messages yet" untuk percakapan berisi riwayat.
        let localLastMessage: Message | null = null;
        try {
            const localMsgs = await shadowVault.getMessagesByConversation(c.id, PREVIEW_SCAN_LIMIT);
            localLastMessage = pickPreviewLastMessage(localMsgs);
        } catch (_e) {}

        let lastMessage = c.lastMessage || null;
        
        if (lastMessage) {
            const originalLastMsg = lastMessage;
            try {
              const { decryptMessageObject } = await import('./message');
              const decryptedLastMsg = await decryptMessageObject(lastMessage);
              lastMessage = decryptedLastMsg || c.lastMessage || null;
            } catch (_e) {
              if (originalLastMsg.sessionId) emitSessionKeyRequest(originalLastMsg.conversationId, originalLastMsg.sessionId);
              lastMessage = originalLastMsg;
              lastMessage.content = '[Requesting key to decrypt...]';
            }
        }

        // Salinan server hanya boleh menang bila ia memang terlihat. Kalau tidak
        // (mis. `lastMessage` server adalah sinyal reaksi atau nisan), preview
        // lokal yang terlihat lebih benar.
        if (lastMessage && !isPreviewableMessage(lastMessage)) lastMessage = null;

        // [docs/28 Tier 2 — B1/B3] pilih yang lebih baru dengan aturan urutan yang
        // sama dengan daftar pesan (bukan sekadar createdAt presisi vs kasar).
        let finalLastMessage = lastMessage;
        if (localLastMessage && (!lastMessage || compareMessagesByOrder(localLastMessage, lastMessage) > 0)) {
            finalLastMessage = localLastMessage;
        }

        if (finalLastMessage) {
            // [P2 NORMALISASI] getParticipantUserId (dulu p.id — bentuk userId
            // terlewat untuk enrich nama pengirim lastMessage).
            const messageSender = finalLastMessage.sender;
            const pInfo = participants.find(p => getParticipantUserId(p) === finalLastMessage!.senderId);
            if (pInfo) {
                finalLastMessage.sender = {
                    ...(messageSender || { id: finalLastMessage.senderId }),
                    ...pInfo,
                    // [BUGFIX 2026-10-18] `pInfo` adalah snapshot LOKAL (roster
                    // participant tak pernah dikirim server) — jangan biarkan ia
                    // menimpa `encryptedProfile` yang datang bersama pesan, karena
                    // nilai pesan itu yang terbaru.
                    ...(typeof messageSender?.encryptedProfile === 'string'
                        ? { encryptedProfile: messageSender.encryptedProfile }
                        : {}),
                };
            }
            finalLastMessage = withPreview(finalLastMessage);
        }
        
        // 🛡️ Guard: Use cached decryptedMetadata from ShadowVault if available.
        // If we always try to decrypt on every page load, the second load will fail
        // because the sender key ratchet has advanced past N=0 (messages were decrypted
        // in the previous session), while metadata was encrypted at N=0.
        // Result: decryptedMetadata gets overwritten with undefined → "Unknown Group".
        // BUGFIX: hasil dekripsi dipersist ke Shadow Vault (lihat lib/groupMetadata.ts).
        const { resolveGroupMetadata } = await import('@lib/groupMetadata');
        const decryptedMetadata = await resolveGroupMetadata(c, {
          decrypt: decryptGroupMetadata,
          save: async (conv) => {
            const { shadowVault } = await import('@lib/shadowVaultDb');
            await shadowVault.saveConversation(conv).catch(() => {});
          },
          cacheParticipants: (id, userIds) => {
            import('@lib/keychainDb').then(m => m.saveCachedGroupParticipants(id, userIds));
          },
        });

        return {
          ...c,
          lastMessage: finalLastMessage,
          participants,
          decryptedMetadata
        };
      }));

      const existingConversations = get().conversations;
      const reconciledConversations = await Promise.all(conversations.map(async fetched => {
          fetched.encryptionMode = fetched.isGroup ? 'SENDER_KEY' : 'SPQR';
          if (fetched.isGroup) {
              const existing = existingConversations.find(e => e.id === fetched.id);
              if (existing) {
                  const existingIds = existing.participants.map(p => p.id).sort().join(',');
                  const fetchedIds = fetched.participants.map(p => p.id).sort().join(',');
                  // [T2 FIX #12 2026-09-29] Server Opaque Mailbox SELALU mengembalikan
                  // participants kosong — perbandingan buta existing (isi) vs fetched
                  // (kosong) selalu "berubah" → requiresKeyRotation setiap kali sync
                  // jalan → pesan pertama setelah reload memaksa rotasi era baru →
                  // penerima dengan receiver state era lama menolak envelope
                  // (N duplikat) → "ciphertext cannot be decrypted using that key"
                  // untuk SEMUA pesan. Rotasi hanya bila server BENAR-BENAR
                  // mengirim roster non-kosong yang berbeda.
                  const rosterChanged = fetchedIds.length > 0 && existingIds !== fetchedIds;
                  if (rosterChanged) {
                      fireGhostSync(fetched.id, 2000);
                      return { ...fetched, requiresKeyRotation: true };
                  }
                  // participants server kosong → pertahankan roster lokal.
                  if (fetchedIds.length === 0) {
                      fetched.participants = existing.participants;
                  }
              }
          }
          return fetched;
      }));

      // [2026-10-18] Jangan timpa preview yang datang SAAT sync berjalan.
      // Perhitungan di atas memakai snapshot vault/server; pesan live yang tiba
      // di tengah await (dekripsi, metadata grup, dsb.) sudah memperbarui
      // store. Tanpa penggabungan ini, preview yang lebih baru hilang lagi —
      // itulah gejala "kadang last message salah" yang sulit direproduksi.
      const liveById = new Map(get().conversations.map((c) => [c.id as string, c]));
      const mergedConversations = reconciledConversations.map((fetched) => {
        const pending = takePendingPreview(fetched.id);
        const live = liveById.get(fetched.id);
        let merged = fetched;

        if (pending) {
          if (!merged.lastMessage || compareMessagesByOrder(pending, merged.lastMessage) > 0) {
            merged = { ...merged, lastMessage: pending };
          }
        }

        if (!live?.lastMessage || !isPreviewableMessage(live.lastMessage)) return merged;
        if (merged.lastMessage && compareMessagesByOrder(live.lastMessage, merged.lastMessage) <= 0) {
          return merged;
        }
        return {
          ...merged,
          lastMessage: live.lastMessage,
          // Unread yang bertambah selama sync juga jangan di-reset ke 0.
          unreadCount: live.unreadCount ?? merged.unreadCount,
        };
      });

      set({ conversations: sortConversations(mergedConversations, useAuthStore.getState().user?.id) });
      useVerificationStore.getState().loadInitialStatus(mergedConversations);

      // [BUGFIX 2026-10-18] Segarkan profil peer 1:1 dari pengirim pesan terakhir.
      // Server tidak mengirim roster participant (Opaque Mailbox), jadi snapshot
      // ini hidup di klien dan dulu tidak pernah di-refresh: avatar/nama di
      // daftar chat & story tray tetap basi sampai reload berikutnya. Pesan
      // membawa `encryptedProfile` terbaru pengirimnya — sumber yang sama yang
      // membuat bubble chat & modal info selalu tampak terbaru.
      for (const c of get().conversations) {
        if (c.isGroup) continue;
        const messageSender = c.lastMessage?.sender;
        const senderEp = messageSender?.encryptedProfile;
        const senderId = messageSender?.id ?? c.lastMessage?.senderId;
        if (typeof senderEp !== 'string' || senderEp.length === 0 || !senderId) continue;
        const peer = c.participants.find(p => getParticipantUserId(p) === String(senderId));
        if (!peer || peer.encryptedProfile === senderEp) continue;
        useConversationStore.getState().updateParticipantDetails({ id: asUserId(String(senderId)), encryptedProfile: senderEp });
      }

      // [CONTACT STORE P1 2026-10-05] Warm contact store + restore backup
      // (device baru/reinstall) + heal participants kosong dari kontak.
      // Semua best-effort — kegagalan tidak boleh menggagalkan sync.
      void (async () => {
        try {
          const { seedContactsFromConversations, restoreContactsFromBundle, buildPeerParticipantsFromContacts } = await import('@lib/contactStore');
          const restored = await restoreContactsFromBundle();
          if (restored > 0) console.info(`[ContactStore] ${restored} kontak dipulihkan dari backup server`);
          // [BUGFIX 2026-10-18] Seed dari STATE terkini, bukan snapshot awal sync:
          // rekonsiliasi profil peer di atas bisa sudah mengganti `encryptedProfile`
          // participant. Menulis snapshot lama akan mendowngrade kontak yang fresh
          // (upsertContact memenangkan nilai non-null) dan mengembalikan avatar basi.
          const currentConversations = useConversationStore.getState().conversations;
          await seedContactsFromConversations(currentConversations);
          for (const c of currentConversations) {
            if (c.isGroup || (c.participants && c.participants.length > 0)) continue;
            const peers = await buildPeerParticipantsFromContacts(c.id);
            if (peers.length > 0) {
              // Persist juga ke vault → load berikutnya tidak kosong lagi.
              useConversationStore.getState().updateConversation(c.id, { participants: peers as unknown as Participant[] });
            }
          }
        } catch (e) {
          console.warn('[ContactStore] Warm/restore kontak gagal (non-fatal):', e);
        }
      })();

      // [26.9 RBAC] Muat admin capability token dari kvStore (terenkripsi
      // at-rest) ke store — agar guard UI & header X-Admin-Token hidup setelah
      // reload. Fire-and-forget: gagal = token di-receive ulang via distribusi.
      import('@lib/groupPseudonyms').then(({ hydrateMyAdminTokens }) => hydrateMyAdminTokens()).catch(() => {});

      const socket = transportClient;

    } catch (error) {
      console.error("Failed to load conversations", error);
      set({ error: "Failed to load conversations." });
    } finally {
      set({ loading: false, initialLoadCompleted: true });
    }
  },

  openConversation: (id: string | null) => {
    if (!id) {
      set({ activeId: null });
      return;
    }
    set(state => ({
      activeId: id,
      isSidebarOpen: false,
      conversations: state.conversations.map(c => 
        c.id === id ? { ...c, unreadCount: 0 } : c
      ),
    }));
  },

  deleteConversation: async (id) => {
    if (id.startsWith('burner_')) {
      set((state) => {
        const newConvos = state.conversations.filter(c => c.id !== id);
        return { 
          conversations: newConvos,
          activeId: state.activeId === id ? null : state.activeId,
          isSidebarOpen: state.activeId === id ? true : state.isSidebarOpen
        };
      });
      try {
        const { shadowVault } = await import('@lib/shadowVaultDb');
        await shadowVault.deleteConversation(id);
      } catch (e) {
        console.error("Failed to delete burner conversation from local DB", e);
      }
      return;
    }
    try {
      await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      get().removeConversation(id);
    } catch (error: unknown) {
      console.error("Failed to delete conversation:", error);
      const errorMessage = (error instanceof Error ? error.message : undefined) || i18n.t('errors:failed_to_delete_conversation', "Failed to delete conversation.");
      toast.error(errorMessage);
    }
  },
  
  deleteGroup: async (id) => {
    try {
      await authFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      get().removeConversation(id);
    } catch (error: unknown) {
      console.error("Failed to delete group:", error);
      if (typeof error === 'object' && error !== null && 'status' in error && (error as Record<string, unknown>).status === 403) {
        toast.error(i18n.t('errors:only_the_group_creator_can_delete_the_gr', 'Only the group creator can delete the group.'));
      } else {
        toast.error(getToastErrorMessage(error, 'errors:failed_to_delete_group', "Failed to delete group."));
      }
    }
  },
  
  toggleSidebar: () => set(s => ({ isSidebarOpen: !s.isSidebarOpen })),

  startConversation: async (peerId: string, optimisticProfile?: { name: string; username: string }): Promise<ConversationId> => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error("Cannot start a conversation: user is not authenticated.");
    }

    try {
      const conv = await authFetch<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          userIds: [peerId],
          isGroup: false,
          initialSession: undefined, 
        }),
      });
      
      // Opaque Mailbox: server returns empty participants, reconstruct locally
      conv.participants = [
        { id: asUserId(user.id), name: '', username: '', role: 'MEMBER' as const },
        { id: asUserId(peerId), name: optimisticProfile?.name || '', username: optimisticProfile?.username || '', role: 'MEMBER' as const }
      ];

      get().addOrUpdateConversation({ ...conv, encryptionMode: 'SPQR' });
      set({ activeId: conv.id, isSidebarOpen: false });
      return conv.id;
    } catch (error: unknown) {
      console.error("Failed to start conversation:", error);
      throw new Error(`Failed to establish conversation. ${(error instanceof Error ? error.message : 'Unknown error') || ''}`);
    }
  },

  createGroup: async (name: string, userIds: string[], avatarUrl?: string): Promise<ConversationId> => {
    const { user } = useAuthStore.getState();
    if (!user) throw new Error("Not authenticated");

    let conv: Conversation | null = null;

    try {
        // [T3b] Creator-issued delivery tokens — SAMA yang masuk encrypted
        // metadata di bawah (single source, full roster termasuk creator).
        const deliveryTokens = await buildDeliveryTokensPayload(userIds);
        // [26.9 RBAC] Admin capability token: dibuat creator (OWNER), hash-nya
        // saja dikirim ke server; token asli di-cache lokal + di-seal pairwise
        // ke admin lain saat promosi (di bawah).
        const { generateAdminCapabilityToken, hashAdminCapabilityToken, storeMyAdminToken } = await import('@lib/groupPseudonyms');
        const adminToken = await generateAdminCapabilityToken();
        const adminSecretHash = await hashAdminCapabilityToken(adminToken);
        const createRes = await authFetch<Conversation & { authSecret: string }>("/api/conversations", {
            method: "POST",
            body: JSON.stringify({
                userIds,
                isGroup: true,
                encryptedMetadata: null,
                // [T3b] Creator-issued delivery tokens per invited member —
                // server menyimpan (conversation, token) untuk discovery.
                deliveryTokens,
                // [26.9 RBAC] SHA-256(adminToken) — server verifikasi X-Admin-Token.
                adminSecretHash
            })
        });
        conv = createRes;
        const authSecret = createRes.authSecret;

        // [docs/28 Tier 0.7 — D14] Presence di server kini peer-scoped (snapshot
        // hanya berisi lawan bicara yang berbagi conversation, bukan roster
        // online global). Anggota yang baru diundang belum ada di snapshot
        // sebelumnya → minta refresh supaya badge online langsung terisi tanpa
        // menunggu reconnect. Best-effort: presence bukan jalur kritis.
        try {
          const { transportClient } = await import('@lib/transportClient');
          transportClient.sendEvent('user:active');
        } catch { /* abaikan */ }

        // Opaque Mailbox: server returns empty participants, reconstruct from userIds
        const constructedParticipants = userIds.map(id => ({ id, name: '', role: 'MEMBER' as const })) as Participant[];
        // [T2 FIX #10 2026-09-29] ensureGroupSession TIDAK dipanggil di sini lagi —
        // encryptGroupMetadata di bawah memicunya internally DENGAN pseudonym
        // eksplisit. DULU ada panggilan awal tanpa opts yang membuat sender state
        // terlanjur ter-create, lalu panggilan dalam encryptGroupMetadata di-skip
        // (guard existingSenderState) → distribusi kunci pertama jalan dengan
        // userId asli (audit DB: GROUP_KEY pertama 25-char).
        // Syaratnya: conv HARUS sudah ada di store dengan participants lengkap
        // sebelum encryptGroupMetadata (lookup store untuk ensureGroupSession
        // internal) — server mengembalikan participants kosong (Opaque Mailbox).
        get().addOrUpdateConversation({ ...conv, participants: constructedParticipants } as Conversation);
        
        // 🛡️ Fix: Include ALL participants (creator + invited users) in the encrypted metadata.
        // Previously only userIds (other members) were included, causing the decrypted metadata
        // to show only the member's own ID (count=1). This left conversation.participants incomplete
        // for Opaque Mailbox, which meant targetRecipients was empty and ensureGroupSessionIfNeeded
        // couldn't distribute the member's sender key to the creator.
        const allParticipantIds = Array.from(new Set([user.id, ...userIds]));
        // [T1] Metadata v2: pseudonym map lives ONLY inside encrypted metadata —
        // server never learns pseudonym→account linkage (doc 26.2).
        const pseudonymMap = await generatePseudonymMap(allParticipantIds);
        // [T2 FIX #10 2026-09-29] Pseudonym SAYA di-resolve REVERSE dari peta —
        // map[myId] selalu undefined karena peta pseudo→uid (leak sebelumnya).
        const myPseudonym = findPseudonymInMap(pseudonymMap, user.id);
        // [T3b] Peta token yang SAMA dikirim ke server (row discovery) dan
        // disimpan di encrypted metadata (backup + anggota menemukan token
        // miliknya setelah decrypt). Token anggota yang ditambahkan belakangan
        // di-issue saat invite message (targetDeliveryTokens).
        const deliveryTokenMap = { ...deliveryTokens, ...(await buildDeliveryTokensPayload([user.id])) };
        // [T4 ROSTER v3] Roster ber-role hidup di dalam metadata: creator = OWNER,
        // undangan = MEMBER. Satu sumber kebenaran untuk UI (admin check, daftar
        // anggota) — server tidak pernah melihat roster/role (Opaque Mailbox).
        const members: GroupMemberEntry[] = [
            { userId: user.id, role: 'OWNER', joinedAtGeneration: 1 },
            ...userIds.filter(uid => uid !== user.id).map(uid => ({ userId: uid, role: 'MEMBER' as const, joinedAtGeneration: 1 })),
        ];
        // [T1 FIX 2026-09-28] Suntikkan pseudonym SAYA dari peta yang baru dibuat
        // (peta belum ada di store saat ensureGroupSession jalan di dalam sini →
        // kalau tidak, GROUP_KEY pertama terkirim dengan userId asli sebagai
        // senderId — ditemukan saat audit DB lokal 2026-09-28).
        const encryptedMetadata = await encryptGroupMetadata({ title: name, avatarUrl, participants: allParticipantIds, authSecret, v: 3, generation: 1, pseudonymMap, deliveryTokenMap, members } as Parameters<typeof encryptGroupMetadata>[0], conv.id, { pseudonym: myPseudonym });
        
        // [BUGFIX 2026-10-10] PUT /:id/details adalah operasi admin (owner/admin
        // role = possession of admin capability token; adminSecretHash selalu
        // terisi untuk grup baru) — tanpa X-Admin-Token server menolak 403 dan
        // createGroup melakukan rollback (grup terhapus). Partisipan/admin lain
        // (ParticipantList, GroupInfoPanel, rotateGroupKey) sudah mengirimnya.
        await authFetch(`/api/conversations/${conv.id}/details`, {
            method: 'PUT',
            headers: {
                'X-Group-Token': authSecret,
                'X-Admin-Token': adminToken,
            },
            body: JSON.stringify({ encryptedMetadata })
        });
        
        // Opaque Mailbox: explicitly notify all members about metadata update
        const myId = useAuthStore.getState().user?.id;
        if (myId) {
            const notifyTargets = userIds.filter(uid => uid !== myId);
            if (notifyTargets.length > 0) {
                // [T2 FIX #10 2026-09-29] Sertakan pseudonym SAYA — pesan SYSTEM
                // METADATA_UPDATED di server tidak boleh membawa userId asli
                // sebagai senderId (audit DB: leak 25-char saat createGroup).
                emitMetadataUpdated(conv.id, encryptedMetadata, notifyTargets, myPseudonym);
            }
        }
        
        const updatedConv: Conversation = {
            ...conv,
            participants: constructedParticipants as Participant[],
            // [T1 FIX 2026-09-28] decryptedMetadata creator harus MIRROR penuh
            // objek metadata v2 yang dienkripsi (termasuk v/generation/
            // pseudonymMap/deliveryTokenMap). Sebelumnya hanya { title,
            // avatarUrl, authSecret } → getPseudonymMap() lihat meta.v !== 2 →
            // resolvePseudonymToUserId() gagal → pesan member gagal dekripsi
            // "Missing sender signing key" di sisi creator (ditemukan E2E manual).
            // Tanpa ini creator tak pernah decrypt ulang metadata-nya sendiri
            // (cache guard) sehingga peta hilang permanen sesi berjalan.
            decryptedMetadata: {
                title: name,
                avatarUrl,
                participants: allParticipantIds,
                authSecret,
                v: 3 as const,
                generation: 1,
                pseudonymMap,
                deliveryTokenMap,
                members
            },
            encryptedMetadata
        };
        
  
        get().addOrUpdateConversation(updatedConv);
        // [26.9 RBAC] Cache token admin creator (store + kvStore terenkripsi).
        storeMyAdminToken(conv.id, adminToken);
        set({ activeId: conv.id, isSidebarOpen: false });
        
        return conv.id;
    } catch (e) {
        if (conv) {
             console.error("Create group failed during setup. Rolling back...", e);
             try {
                 await authFetch(`/api/conversations/${conv!.id}`, { method: 'DELETE' });
             } catch (rollbackError) {
                 console.error("Rollback failed", rollbackError);
             }
        }
        throw e;
    }
  },

  addOrUpdateConversation: async (conversation) => {
    let decryptedMetadata = conversation.decryptedMetadata;
    
    // 🛡️ Guard: Skip re-decryption if the conversation already exists in store with
    // decrypted metadata and the encrypted payload hasn't changed. Without this guard,
    // redundant decryptGroupMetadata calls will ratchet the sender key state past N=0
    // while metadata was encrypted at N=0, causing permanent decrypt failure.
    if (!decryptedMetadata && conversation.isGroup && conversation.encryptedMetadata) {
        const existing = useConversationStore.getState().conversations.find(c => c.id === conversation.id);
        if (existing?.decryptedMetadata && existing.encryptedMetadata === conversation.encryptedMetadata) {
            decryptedMetadata = existing.decryptedMetadata;
            // Also forward participants from cached metadata to prevent overwrite with empty
            // (caller may pass conversation with empty participants in Opaque Mailbox)
            const metaParticipants = (decryptedMetadata as { participants?: string[] }).participants;
            if (Array.isArray(metaParticipants) && metaParticipants.length > 0 &&
                (!conversation.participants || conversation.participants.length === 0)) {
                const currentUser = useAuthStore.getState().user;
                conversation.participants = metaParticipants.map((pid: string) => ({
                    id: pid, name: pid === currentUser?.id ? currentUser.name || '' : '', role: 'MEMBER' as const
                })) as Participant[];
            }
        } else {
            try {
                const dec = await decryptGroupMetadata(String(conversation.encryptedMetadata), conversation.id);
                if (dec) {
                    decryptedMetadata = dec;
                    // Opaque Mailbox: extract participants from encrypted metadata
                    const metaParticipants = (dec as { participants?: string[] }).participants;
                    if (Array.isArray(metaParticipants) && metaParticipants.length > 0 &&
                        (!conversation.participants || conversation.participants.length === 0)) {
                        const currentUser = useAuthStore.getState().user;
                        conversation.participants = metaParticipants.map((id: string) => ({
                            id, name: id === currentUser?.id ? currentUser.name || '' : '', role: 'MEMBER' as const
                        })) as Participant[];
                    // Persist to IndexedDB so non-creator members can send messages even before metadata is re-decrypted
                    import('@lib/keychainDb').then(m => m.saveCachedGroupParticipants(conversation.id, metaParticipants));
                }
                // [PROFILE KEY DISTRIBUTION 2026-10-05] Kunci profil anggota dari
                // roster v3 → keychain (kanal utama; anggota pasif ikut kebagian).
                void import('@lib/groupProfileKeys').then(({ applyGroupProfileKeys }) =>
                    applyGroupProfileKeys(conversation.id, (dec as { members?: unknown }).members)
                ).catch(() => {});
                    // [BUGFIX PESAN PERTAMA 2026-10-02] Metadata BARU SAJA berhasil
                    // didecrypt (sebelumnya pending/gagal karena chain key belum
                    // tiba). Re-decrypt pesan yang tertahan waiting_for_key — dulu
                    // jalur ini cuma skip diam-diam, dan storeReceivedSessionKey
                    // menunggu "metadataDecrypted" yang tidak pernah di-follow-up
                    // → pesan pertama grup baru stuck gagal sampai pesan kedua.
                    import('@store/message').then(({ useMessageStore }) => {
                        useMessageStore.getState().reDecryptPendingMessages(conversation.id);
                    });
                }
            } catch (e) {
                console.warn("Failed to decrypt metadata for conversation", e);
            }
        }
    }

    // Diambil sekali di luar `set` supaya kedua cabang (baru/lama) melihat
    // preview yang sama — `takePendingPreview` menghapus entri saat dibaca.
    const pendingPreview = takePendingPreview(conversation.id);

    set(state => {
      const existing = state.conversations.find(c => c.id === conversation.id);
      let updatedConv: Conversation;
      if (existing) {
        // [AUDIT FIX 2026-10-05 — ANTI-REGRESI ERA] Replay METADATA_UPDATED era
        // LAMA (SYSTEM persist 7 hari) tidak boleh menimpa blob BARU yang sudah
        // berhasil terdekripsi: dulu blob di-store apa adanya → pasangan
        // (blob era-1, decryptedMetadata era-2) inkonsisten → decryptGroupMetadata
        // gagal berulang "metadataKey era belum tersedia" (log C 13:21:23).
        const keepExistingBlob =
          !decryptedMetadata &&
          !!existing.decryptedMetadata &&
          !!conversation.encryptedMetadata &&
          conversation.encryptedMetadata !== existing.encryptedMetadata;
        // [2026-10-18] Preview tertunda dari pesan yang tiba sebelum
        // percakapan ini ada di store (`conversation:new` datang belakangan).
        const incomingLast = conversation.lastMessage && isPreviewableMessage(conversation.lastMessage)
          ? conversation.lastMessage
          : null;
        const keepLast = pendingPreview &&
          (!existing.lastMessage || compareMessagesByOrder(pendingPreview, existing.lastMessage) > 0)
          ? pendingPreview
          : existing.lastMessage;

        updatedConv = {
          ...existing,
          encryptedMetadata: keepExistingBlob
            ? existing.encryptedMetadata
            : conversation.encryptedMetadata,
          decryptedMetadata: decryptedMetadata || existing.decryptedMetadata,
          isGroup: conversation.isGroup,
          participants: conversation.participants,
          lastMessage: incomingLast || keepLast,
          updatedAt: conversation.updatedAt,
          unreadCount: conversation.unreadCount ?? existing.unreadCount,
        } as Conversation;

        // PERSIST TO SHADOW VAULT (Opaque Mailbox)
        import('@lib/shadowVaultDb').then(m => m.shadowVault.saveConversation(updatedConv));

        return {
          conversations: sortConversations(state.conversations.map(c => c.id === conversation.id ? updatedConv : c), useAuthStore.getState().user?.id)
        };
      } else {
        const incomingLast = conversation.lastMessage && isPreviewableMessage(conversation.lastMessage)
          ? conversation.lastMessage
          : null;
        updatedConv = {
          ...conversation,
          decryptedMetadata,
          lastMessage: incomingLast || pendingPreview || null,
        } as Conversation;

        // PERSIST TO SHADOW VAULT (Opaque Mailbox)
        import('@lib/shadowVaultDb').then(m => m.shadowVault.saveConversation(updatedConv));

        return {
          conversations: sortConversations([updatedConv, ...state.conversations], useAuthStore.getState().user?.id)
        };
      }
    });

    // [PROFILE KEY DISTRIBUTION 2026-10-05] Titik reaksi tunggal SETELAH store
    // terisi — mencakup SEMUA jalur masuk metadata (sync awal, replay SYSTEM
    // METADATA_UPDATED, addParticipant, dsb.). applyGroupProfileKeys:
    //   • simpan kunci profil anggota dari roster v3 (first-wins);
    //   • bila entri SAYA belum membawa kunci → trigger silent PROFILE_SYNC
    //     sekali per (device, conversation) — fallback anggota pasif.
    if (conversation.isGroup && decryptedMetadata) {
      void import('@lib/groupProfileKeys').then(({ applyGroupProfileKeys }) =>
        applyGroupProfileKeys(conversation.id, (decryptedMetadata as { members?: unknown }).members)
      ).catch(() => {});
    }
  },

  removeConversation: (conversationId, opts) => {
    // [BUGFIX 2026-10-18] Kick bukan penghapusan permanen: server mengirim
    // `conversation:deleted` dengan `reason: 'removed'`, dan klien TIDAK boleh
    // membuang riwayat + kunci era. Dulu `deleteConversation()` di bawah
    // menghapus semua receiver state/arsip + pesan vault; setelah di-add
    // kembali, pesan lama ikut di-fetch ulang dari server tanpa kunci era —
    // hanya pesan yang message-key-nya sempat di-cache yang bisa dibaca,
    // sisanya "waiting_for_key".
    const preserveHistory = opts?.preserveHistory === true;
    (async () => {
      const { useMessageStore } = await import('./message');
      useMessageStore.getState().clearMessagesForConversation(conversationId, { preserveVault: preserveHistory });
      // Persist penghapusan ke Shadow Vault agar percakapan tidak "hidup kembali"
      // saat reload (loadConversations membaca dari IndexedDB).
      const { shadowVault } = await import('@lib/shadowVaultDb');
      if (preserveHistory) {
        // Hanya record percakapan yang dilepas; pesan + state kripto tetap.
        await shadowVault.forgetConversation(conversationId);
      } else {
        await shadowVault.deleteConversation(conversationId);
      }
    })();

    set(state => {
      const wasActive = state.activeId === conversationId;
      if (wasActive) {
        return {
          conversations: state.conversations.filter(c => c.id !== conversationId),
          activeId: null,
          isSidebarOpen: true,
        };
      }
      return { conversations: state.conversations.filter(c => c.id !== conversationId) };
    });
  },

  updateConversation: async (id, data) => {
    let decryptedMetadata = undefined;
    if (data.encryptedMetadata) {
         // 🛡️ Guard: Skip re-decryption if metadata is already cached and the encrypted payload
         // hasn't changed. Otherwise, the second call would ratchet the sender key state past N=0
         // while the metadata was encrypted at N=0, causing permanent decrypt failure:
         //   "Ratchet Advanced! Cannot decrypt old message (header.n=0, state.N=1)"
         const existing = get().conversations.find(c => c.id === id);
         if (existing?.decryptedMetadata && existing.encryptedMetadata === data.encryptedMetadata) {
             decryptedMetadata = existing.decryptedMetadata;
             if (Array.isArray((decryptedMetadata as { participants?: string[] }).participants) && (decryptedMetadata as { participants?: string[] }).participants!.length > 0) {
                 data.participants = (decryptedMetadata as { participants?: string[] }).participants!.map((pid: string) => ({
                     id: asUserId(pid), name: pid === useAuthStore.getState().user?.id ? useAuthStore.getState().user?.name || '' : '', role: 'MEMBER' as const
                 }));
             }
         } else {
         try {
             const dec = await decryptGroupMetadata(data.encryptedMetadata, id);
             if (dec) {
                 decryptedMetadata = dec;
                 // [HEAL 2026-10-01] Metadata baru sukses terdekripsi → pesan pending
                 // yang sebelumnya gagal (waiting_for_key / ratchet advanced) perlu
                 // diproses ulang. Retry di message.ts hanya jalan SEKALI; tanpa
                 // trigger ini pesan gagal permanen walau kunci sudah sampai
                 // (log 2-browser 2026-10-01: metadata terdekripsi via offline sync
                 // tapi pesan user tidak pernah di-decrypt ulang).
                 import('@store/message').then(({ useMessageStore }) => {
                     setTimeout(() => useMessageStore.getState().reDecryptPendingMessages(id), 150);
                 }).catch(() => {});
                 // Opaque Mailbox: extract participants from decrypted metadata
                 const metaParticipants = (dec as { participants?: string[] }).participants;
                 if (Array.isArray(metaParticipants) && metaParticipants.length > 0) {
                     const currentUser = useAuthStore.getState().user;
                     data.participants = metaParticipants.map((pid: string) => ({
                         id: asUserId(pid), name: pid === currentUser?.id ? currentUser.name || '' : '', role: 'MEMBER' as const
                     }));
                     // Persist to IndexedDB cache for offline/early message sending
                     import('@lib/keychainDb').then(m => m.saveCachedGroupParticipants(id, metaParticipants));
                 }
                 // [PROFILE KEY DISTRIBUTION 2026-10-05] Kanal utama (metadata era
                 // baru) — simpan kunci profil anggota dari roster v3.
                 void import('@lib/groupProfileKeys').then(({ applyGroupProfileKeys }) =>
                     applyGroupProfileKeys(id, (dec as { members?: unknown }).members)
                 ).catch(() => {});
             } else {
                 console.warn("Failed to decrypt metadata");
             }
         } catch (e) {
             console.warn("Failed to decrypt updated metadata", e);
         }
         }
    }

    set((state) => {
        // [AUDIT FIX 2026-10-05] forceRotateGroupSenderKey saat roster berubah
        // DIHAPUS: keanggotaan berubah ditangani rotasi eksplisit ADMIN
        // (rotateGroupKey) — anggota lain yang menghapus sender state-nya
        // sendiri hanya menciptakan churn era (bukti log: B membuat 2 era
        // dalam 13 detik saat C ditambahkan) dan deviasi dari model libsignal
        // (rantai sender tiap anggota independen dari roster).
        // [AUDIT FIX 2026-10-05 — ANTI-REGRESI ERA] Sama seperti addOrUpdate:
        // blob lama yang gagal didekripsi tidak boleh menimpa blob baru yang
        // sudah terdekripsi di store.
        const oldConvForBlob = state.conversations.find((c) => c.id === id);
        const keepBlob =
          !decryptedMetadata &&
          !!oldConvForBlob?.decryptedMetadata &&
          !!data.encryptedMetadata &&
          data.encryptedMetadata !== oldConvForBlob.encryptedMetadata;
        const patch = keepBlob ? { ...data, encryptedMetadata: oldConvForBlob.encryptedMetadata } : data;
        return {
          conversations: state.conversations.map((c) =>
            c.id === id ? { 
                ...c, 
                ...patch,
                decryptedMetadata: decryptedMetadata || c.decryptedMetadata 
            } : c
          ),
        };
    });
  },

  updateParticipantDetails: (user) => {
    const { role, ...userDetails } = user;
    // [BUGFIX 2026-10-18] user:updated membawa userId ASLI; `id` kosong/aneh
    // tidak boleh dianggap cocok dengan participant mana pun.
    const targetId = typeof user.id === 'string' && user.id.length > 0 ? String(user.id) : null;
    if (!targetId) return;

    // [P2 NORMALISASI] participant grup v2 berbentuk pseudonym — resolusi via
    // pseudoMap agar update profil tetap sampai. Dipakai untuk DETEKSI dan
    // untuk PENULISAN (dulu penulisan masih `p.id !== user.id` → event profil
    // tak pernah mengubah participant pseudonym).
    const matchesParticipant = (c: Conversation, p: Participant): boolean => {
      if (String(getParticipantUserId(p)) === targetId) return true;
      if (String(p.id) === targetId) return true;
      const pseudoMap = getPseudonymMap(c.id);
      return !!pseudoMap && String(p.id) !== targetId && pseudoMap[String(p.id)] === targetId;
    };

    const affectedConvoIds: string[] = [];
    const updatedConversations: Conversation[] = [];

    const nextConversations = get().conversations.map(c => {
      const existingParticipant = c.participants.find(p => matchesParticipant(c, p));
      if (!existingParticipant) return c;

      // Check for cryptographic or membership changes
      const hasCryptoChanged = 
        (userDetails.publicKey !== undefined && userDetails.publicKey !== existingParticipant.publicKey) ||
        (userDetails.pqPublicKey !== undefined && userDetails.pqPublicKey !== existingParticipant.pqPublicKey) ||
        (userDetails.signingKey !== undefined && userDetails.signingKey !== existingParticipant.signingKey) ||
        (userDetails.devices !== undefined && JSON.stringify(userDetails.devices) !== JSON.stringify(existingParticipant.devices)) ||
        (role !== undefined && role !== existingParticipant.role);

      if (hasCryptoChanged) {
        affectedConvoIds.push(c.id);
        import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(c.id).catch(captureAndLog));
      }

      let participantChanged = false;
      const participants = c.participants.map(p => {
        if (!matchesParticipant(c, p)) return p;

        const updatedParticipant = { ...p, ...userDetails };
        // Pseudonym HARUS dipertahankan — menimpanya dengan userId asli
        // membocorkan identitas anggota grup dan merusak peta pseudonym.
        if (String(p.id) !== targetId) updatedParticipant.id = p.id;
        if (role === "ADMIN" || role === "MEMBER" || role === "admin" || role === "member") {
          updatedParticipant.role = role;
        }
        // Hindari menulis vault / memicu re-render untuk event yang tidak
        // mengubah apa pun (mis. `user:updated` milik diri sendiri dengan ep sama).
        if (JSON.stringify(updatedParticipant) !== JSON.stringify(p)) participantChanged = true;
        return updatedParticipant;
      });

      if (!participantChanged && !hasCryptoChanged) return c;

      const updatedConversation: Conversation = {
        ...c,
        requiresKeyRotation: affectedConvoIds.includes(c.id) ? true : c.requiresKeyRotation,
        participants,
      };
      updatedConversations.push(updatedConversation);
      return updatedConversation;
    });

    set({ conversations: nextConversations });

    // [BUGFIX 2026-10-18] Efek samping HARUS di luar `set`.
    //
    // 1. Persist ke ShadowVault. Participants hanya hidup di sisi klien
    //    (Opaque Mailbox) dan `loadConversations` membacanya dari vault — tanpa
    //    ini profil baru hilang lagi setelah reload.
    // 2. Dekripsi profil baru segera: UI lain (daftar chat, story tray, panel
    //    info) membaca cache profil; mendekripsikan di sini membuat ketiganya
    //    ikut segar walau tidak sedang dirender.
    // 3. Segarkan contact store (picker grup/story + backup bundle) agar tidak
    //    mempertahankan blob lama.
    if (updatedConversations.length > 0) {
      void import('@lib/shadowVaultDb')
        .then(({ shadowVault }) => Promise.all(updatedConversations.map(c => shadowVault.saveConversation(c))))
        .catch(captureAndLog);
    }
    if (
      updatedConversations.length > 0 &&
      typeof userDetails.encryptedProfile === 'string' &&
      userDetails.encryptedProfile.length > 0
    ) {
      const encryptedProfile = userDetails.encryptedProfile;
      void import('./profile')
        .then(({ useProfileStore }) => useProfileStore.getState().decryptAndCache(targetId, encryptedProfile))
        .catch(captureAndLog);
      void import('@lib/contactStore')
        .then(({ upsertContact }) => upsertContact({ userId: targetId, encryptedProfile }))
        .catch(captureAndLog);
    }
  },

  addParticipants: (conversationId, newParticipants, opts) => {
    // [BUGFIX 2026-10-18] forceRotateGroupSenderKey DIHAPUS: pemanggil admin
    // (AddParticipantModal / GroupInfoPanel) memanggil rotateGroupKey eksplisit
    // setelah POST add-participants. Dua jalur bersamaan = rotasi era ganda
    // dalam hitungan detik (churn keyId). requiresKeyRotation: true di bawah
    // tetap menjaga lazy rotation untuk jalur non-admin.
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          const merged = [...c.participants, ...newParticipants];

          // FIX: Type-safe unique map based on strict Participant ID
          const uniqueMap = new Map<string, Participant>();
          merged.forEach(p => {
             if (p && p.id) uniqueMap.set(p.id, p);
          });

          // [T4 ROSTER v3] Metadata = sumber kebenaran roster: anggota baru
          // masuk members (MEMBER, generation berjalan) SEKARANG — tanpa ini
          // rotateGroupKey yang dipanggil segera setelah POST akan
          // mengenkripsi roster TANPA anggota baru (race mirip kick).
          let decryptedMetadata = c.decryptedMetadata;
          const meta = decryptedMetadata as {
            v?: number;
            generation?: number;
            participants?: string[];
            members?: GroupMemberEntry[];
            deliveryTokenMap?: Record<string, string>;
          } | undefined;
          if (meta) {
            let nextMeta = meta;
            if (meta.v === 3) {
              const known = new Set((meta.members ?? []).map(m => m.userId));
              const additions = newParticipants.filter(p => !known.has(p.id as string));
              if (additions.length > 0) {
                nextMeta = {
                  ...meta,
                  participants: Array.from(new Set([...(meta.participants ?? []), ...additions.map(p => p.id as string)])),
                  members: [
                    ...(meta.members ?? []),
                    ...additions.map(p => ({ userId: p.id as string, role: 'MEMBER' as const, joinedAtGeneration: meta.generation ?? 1 })),
                  ],
                };
              }
            }
            // Token baru MENANG atas token lama (nama/userId yang sama tidak
            // bisa punya dua token aktif).
            if (opts?.deliveryTokens && Object.keys(opts.deliveryTokens).length > 0) {
              nextMeta = {
                ...nextMeta,
                deliveryTokenMap: { ...nextMeta.deliveryTokenMap, ...opts.deliveryTokens },
              };
            }
            if (nextMeta !== meta) decryptedMetadata = nextMeta as typeof decryptedMetadata;
          }

          return { ...c, participants: Array.from(uniqueMap.values()), decryptedMetadata, requiresKeyRotation: true };
        }
        return c;
      }),
    }));
  },

  removeParticipant: (conversationId, userId) => {
    import('@utils/crypto').then(m => m.forceRotateGroupSenderKey(conversationId).catch(captureAndLog));
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          // [T4 ROSTER v3] Hapus JUGA dari metadata.members/participants —
          // kalau tidak, roster-sync (metadata = sumber kebenaran) akan
          // mem-mirror kicked member KEMBALI ke participants (bug: kicked
          // user tetap "Already a member" di modal add).
          let decryptedMetadata = c.decryptedMetadata;
          const meta = decryptedMetadata as { v?: number; participants?: string[]; members?: GroupMemberEntry[] } | undefined;
          if (meta?.v === 3) {
            decryptedMetadata = {
              ...meta,
              participants: meta.participants?.filter(pid => pid !== userId),
              members: meta.members?.filter(m => m.userId !== userId),
            } as typeof decryptedMetadata;
          }
          return {
            ...c,
            participants: c.participants.filter(p => p.id !== userId),
            decryptedMetadata,
            requiresKeyRotation: true,
          };
        }
        return c;
      }),
    }));
  },

  updateParticipantRole: (conversationId, userId, role) => {
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id === conversationId) {
          return { ...c, participants: c.participants.map(p => p.id === userId ? { ...p, role } : p) };
        }
        return c;
      }),
    }));
  },

  // [T4 ROSTER v3] Mirror roster metadata (sumber kebenaran) ke participants
  // store — UI lama yang masih baca participants tetap konsisten (nama kosong
  // diperbolehkan; profil di-resolve via useUserProfile). Hanya menambah/
  // meng-update role; TIDAK menghapus pesan/metadata lain.
  syncParticipantsFromMetadata: (conversationId, members) => {
    // [T4] Validasi roster di boundary store (parseGroupMembers buang entri
    // korup + fail-safe role MEMBER) — mirror tidak pernah lebih longgar
    // dari parser metadata.
    const roster = parseGroupMembers(members);
    set(state => ({
      conversations: state.conversations.map(c => {
        if (c.id !== conversationId) return c;
        const existingById = new Map<string, Participant>(c.participants.map(p => [p.id as string, p]));
        const participants = roster.map(m => {
          const existing = existingById.get(m.userId);
          return {
            id: existing?.id ?? (asUserId(m.userId)),
            name: existing?.name || '',
            username: existing?.username,
            avatarUrl: existing?.avatarUrl,
            encryptedProfile: existing?.encryptedProfile,
            role: m.role as Participant['role'],
          } as Participant;
        });
        return { ...c, participants };
      }),
    }));
  },

  updateConversationLastMessage: (conversationId, message) => {
    // [2026-10-18] Pesan yang tidak terlihat di UI (pesan kontrol, nisan, baris
    // tanpa isi) TIDAK boleh menjadi preview: dulu CALL_INIT/GHOST_SYNC yang
    // masuk lewat socket menimpa preview percakapan menjadi kosong → daftar
    // chat menampilkan "belum ada pesan" padahal riwayatnya ada. Pesan seperti
    // ini juga tidak menaikkan unread — tidak ada yang bisa dibaca pengguna.
    if (!isPreviewableMessage(message)) return;

    set(state => {
      const conversation = state.conversations.find(c => c.id === conversationId);
      if (!conversation) {
        // Pesan bisa tiba sebelum `conversation:new` (atau sebelum sync
        // menemukan percakapannya). Simpan preview-nya agar tidak hilang.
        rememberPendingPreview(conversationId, message);
        return state;
      }

      const meId = useAuthStore.getState().user?.id;
      const isMine = message.senderId === meId;

      // [docs/28 Tier 2 — B1/B3] `createdAt` server kini kasar (bucket 15 mnt)
      // sementara lastMessage lokal bisa presisi (sentAt) — membandingkan waktu
      // mentah bisa menilai pesan BARU sebagai "lebih lama" sehingga preview chat
      // tak ikut ter-update. Pakai aturan urutan yang sama dengan daftar pesan.
      const isNewerOrSame = !conversation.lastMessage ||
        compareMessagesByOrder(message, conversation.lastMessage) >= 0;
      
      const isViewingChat = typeof window !== 'undefined' && window.location.pathname.includes(`/chat/${conversationId}`) && document.visibilityState === 'visible';

      // [FIX #98] Satu pesan hanya boleh menaikkan unread SEKALI per sesi.
      // Cek watermark SEBELUM cabang mana pun yang menaikkan counter.
      // Pesan milik sendiri tidak pernah masuk watermark (tidak relevan).
      const incrementsUnread = !isMine && !isViewingChat;
      if (incrementsUnread && unreadCountedMessageIds.has(message.id)) {
        // Pesan ini sudah pernah dihitung — jangan sentuh unreadCount lagi.
        // (Preview tetap boleh diperbarui.)
        if (isNewerOrSame) {
          const updatedConversation = { ...conversation, lastMessage: withPreview(message) };
          const otherConversations = state.conversations.filter(c => c.id !== conversationId);
          return { conversations: sortConversations([updatedConversation, ...otherConversations], meId) };
        }
        return state;
      }

      if (!isNewerOrSame) {
          // FIX: Pastikan kita tetap mengembalikan hasil array yang di-sort!
          if (incrementsUnread) {
              markUnreadCounted(message.id);
              const updatedConvos = state.conversations.map(c =>
                  c.id === conversationId
                      ? { ...c, unreadCount: (c.unreadCount || 0) + 1 }
                      : c
              );
              return { conversations: sortConversations(updatedConvos, meId) };
          }
          return state;
      }

      if (incrementsUnread) markUnreadCounted(message.id);
      
      const updatedConversation = {
        ...conversation,
        lastMessage: withPreview(message),
        unreadCount: (incrementsUnread ? (conversation.unreadCount || 0) + 1 : conversation.unreadCount),
      };
      
      const otherConversations = state.conversations.filter(c => c.id !== conversationId);
      return { conversations: sortConversations([updatedConversation, ...otherConversations], meId) };
    });
  },

  /**
   * [2026-10-18] Pasang preview TANPA aturan urutan — dipakai saat pesan yang
   * selama ini menjadi preview dihapus/di-unsend: penggantinya pasti lebih tua,
   * jadi `updateConversationLastMessage` (yang menolak pesan lebih lama) tidak
   * bisa dipakai. `null` = tidak ada lagi pesan terlihat (riwayat habis).
   */
  forceConversationLastMessage: (conversationId, message) => {
    set(state => {
      const conversation = state.conversations.find(c => c.id === conversationId);
      if (!conversation) return state;

      const meId = useAuthStore.getState().user?.id;
      const updatedConversation = {
        ...conversation,
        lastMessage: message && isPreviewableMessage(message) ? withPreview(message) : null,
      };
      const otherConversations = state.conversations.filter(c => c.id !== conversationId);
      return { conversations: sortConversations([updatedConversation, ...otherConversations], meId) };
    });
  },

  performHandshake: async (conversationId: string) => {
    const { conversations } = get();
    const conv = conversations.find(c => c.id === conversationId);
    if (!conv || conv.isGroup) return;

    // Set status to handshaking
    set(state => ({
        conversations: state.conversations.map(c => 
            c.id === conversationId ? { ...c, handshakeStatus: 'handshaking' } : c
        )
    }));

    try {
        const { getPreKeyBundle } = await import('@lib/api');
        const { establishSessionFromPreKeyBundle } = await import('@utils/crypto');
        const { shadowVault } = await import('@lib/shadowVaultDb');
        const { useAuthStore } = await import('./auth');
        
        // [P2 NORMALISASI] getParticipantUserId (dulu p.id buta).
        const myId = useAuthStore.getState().user?.id;
        const peer = conv.participants.find(p => getParticipantUserId(p) !== myId);
        const peerId = peer ? getParticipantUserId(peer) : undefined;
        if (!peerId) throw new Error("Peer not found");

        const bundle = await getPreKeyBundle(peerId);
        const { getSodiumLib } = await import('@utils/crypto');
        const sodium = await getSodiumLib();
        
        const { sessionKey, initiatorCiphertexts, identityChanged } = await establishSessionFromPreKeyBundle(bundle, peerId);

        // [SECURITY WARNING] Insert system message if identity changed
        if (identityChanged) {
            const { useMessageStore } = await import('@store/message');
            const { t } = await import('i18next');
            // [P2] pakai `peer` hasil pencarian ternormalisasi di atas (dulu
            // re-find p.id === peerId yang membentuk duplikasi logika).
            const peerName = peer?.name || peer?.user?.name || t('common:defaults.unknown_user');
            const warningText = t('common:security_key_changed', { name: peerName });
            useMessageStore.getState().addSystemMessage(conversationId, warningText);
        }

        // Start Binary Handshake over WebTransport
        return new Promise<void>((resolve, reject) => {
            const handler = (success: boolean, error?: string) => {
                clearTimeout(timeoutId);
                transportClient.off('handshake:completed', handler);
                if (success) {
                    // Store Session Key
                    shadowVault.savePqDrSession({
                        conversationId,
                        peerClassicalPk: bundle.identityKey,
                        peerDeviceId: bundle.deviceId,
                        version: 1,
                        negotiationStatus: 'ESTABLISHED',
                        lastActivity: Date.now(),
                        state: {
                            RK: sodium.to_base64(sessionKey, sodium.base64_variants.URLSAFE_NO_PADDING),
                            CKs: null,
                            CKr: null,
                            KEMs_pub: null,
                            KEMs_priv: null,
                            KEMr: null,
                            savedCt: null,
                            Ns: 0,
                            Nr: 0,
                            PN: 0
                        }
                    }).then(() => {
                        set(state => ({
                            conversations: state.conversations.map(c => 
                                c.id === conversationId ? { ...c, handshakeStatus: 'secure', encryptionMode: 'SPQR' } : c
                            )
                        }));
                        resolve();
                    }).catch(reject);
                } else {
                    reject(new Error(error || "Handshake failed"));
                }
            };

            const timeoutId = setTimeout(() => {
                transportClient.off('handshake:completed', handler);
                reject(new Error("Handshake timed out"));
            }, 5000);

            transportClient.on('handshake:completed', handler);
            transportClient.startHandshake(initiatorCiphertexts);
        });

    } catch (e: unknown) {
        console.error("Handshake failed action:", e);
        set(state => ({
            conversations: state.conversations.map(c => 
                c.id === conversationId ? { ...c, handshakeStatus: 'failed' } : c
            )
        }));
        toast.error(`Handshake failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
    }
  },

  togglePinConversation: async (conversationId) => {
    const meId = useAuthStore.getState().user?.id;
    try {
      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === meId) {
                return { ...participant, isPinned: !participant.isPinned };
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, meId) };
      });

      const response = await authFetch<{ isPinned: boolean }>(`/api/conversations/${conversationId}/pin`, {
        method: 'POST',
      });

      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === meId) {
                return { ...participant, isPinned: response.isPinned };
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, meId) };
      });
    } catch (error: unknown) {
      console.error("Failed to toggle pinned conversation", error);
      const errorMessage = (error instanceof Error ? error.message : undefined) || i18n.t('errors:failed_to_toggle_pinned_conversation', "Failed to toggle pinned conversation.");
      toast.error(errorMessage);
      
      set(state => {
        const updatedConversations = state.conversations.map(conversation => {
          if (conversation.id === conversationId) {
            const updatedParticipants = conversation.participants.map(participant => {
              if (participant.id === meId) {
                return { ...participant, isPinned: !participant.isPinned }; 
              }
              return participant;
            });
            return { ...conversation, participants: updatedParticipants };
          }
          return conversation;
        });
        return { conversations: sortConversations(updatedConversations, meId) };
      });
    }
  },
}));