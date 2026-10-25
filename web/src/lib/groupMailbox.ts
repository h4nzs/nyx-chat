// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.2] Mailbox grup — transport distribusi kunci tanpa graf.
 *
 * Jalur lama (`group:fulfilled_key`) memberi server tepi requester→fulfiller
 * DAN mempersist `targetDeviceKey` pada baris SYSTEM `GROUP_KEY`. Di mailbox
 * tidak ada kolom pengirim: item ditulis ke percakapan + era, dan penerima
 * dikenali lewat tag opaque `HMAC(memberTokenPenerima, "nyx-mailbox-v1")`.
 * Server hanya melihat "grup G menerima item", bukan siapa mengirim ke siapa.
 *
 * Kontrak server (`server/src/utils/groupMailbox.ts`):
 *  - `POST /api/groups/:id/mailbox`      `{ token, items[] }` → 201
 *  - `POST /api/groups/:id/mailbox/pull` `{ token, cursor?, limit? }` → items
 *  - auth post = possession **group token** era berjalan; pull juga menerima
 *    **member token** era berjalan (fallback anggota offline setelah rotasi).
 *
 * Modul ini sengaja ringan (tanpa crypto worker): envelope sudah ter-seal
 * sebelum sampai di sini, jadi ia hanya meng-encode/meng-address/mengantar.
 */

import { api } from '@lib/api';
import { getDeliveryTokenMap, getMyDeliveryToken, getMyGroupToken } from '@lib/groupPseudonyms';
import { base64UrlToBytes, bytesToBase64Url } from './base64url';

/** Label HMAC tag alamat — HARUS sama dengan dokumentasi server (docs/37). */
export const MAILBOX_TAG_LABEL = 'nyx-mailbox-v1';

/** Batas keras server: payload base64url > 8 KB ditolak (`MAILBOX_REJECTED`). */
export const MAILBOX_MAX_PAYLOAD_BYTES = 8 * 1024;

/** Server membatasi 32 item per post; sisanya dipecah ke beberapa post. */
export const MAILBOX_MAX_ITEMS_PER_POST = 32;

/** Interval poll default: cukup cepat untuk rotasi, jauh di bawah rate limit. */
export const MAILBOX_POLL_INTERVAL_MS = 10_000;

export type MailboxKind = 'KEY_REQUEST' | 'KEY_ENVELOPE' | 'META' | 'COVER';

export interface MailboxPostItem {
  kind: MailboxKind;
  /** Alamat opaque penerima; undefined = broadcast (META/COVER). */
  tag?: string;
  /** base64url dari JSON payload (opaque bagi server). */
  payload: string;
}

export interface MailboxItem {
  id: string;
  kind: string;
  tag?: string;
  payload: string;
  createdAt: string;
}

export interface MailboxPullPage {
  epoch: number;
  items: MailboxItem[];
  nextCursor: string | null;
  truncated: boolean;
}

/**
 * Tag alamat untuk member token penerima. 32 byte HMAC → 43 char base64url
 * (regex server `^[A-Za-z0-9_-]{43}$`). Tanpa token = item tidak bisa dialamatkan
 * ke anggota itu (pemanggil harus memakai jalur fallback, bukan broadcast —
 * broadcast envelope akan membuat SEMUA anggota mencoba unseal).
 */
export async function deriveMailboxTag (memberToken: string | undefined | null): Promise<string | undefined> {
  if (!memberToken) return undefined;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(memberToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(MAILBOX_TAG_LABEL));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Encode payload JSON → base64url. `null` bila melebihi batas server. */
export function encodeMailboxPayload (value: unknown): string | null {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAILBOX_MAX_PAYLOAD_BYTES) return null;
  return bytesToBase64Url(bytes);
}

/** Decode payload base64url → objek JSON; `null` bila rusak/bukan objek. */
export function decodeMailboxPayload<T = Record<string, unknown>> (payload: string): T | null {
  try {
    const bytes = base64UrlToBytes(payload);
    if (bytes.length === 0 || bytes.length > MAILBOX_MAX_PAYLOAD_BYTES) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

// --- Post ---

/**
 * Tulis batch ke mailbox. `0` = tidak dikirim (tanpa group token / kosong),
 * melempar error hanya bila server menolak (403/404/429/500) — pemanggil yang
 * memutuskan fallback.
 */
export async function postGroupMailboxItems (
  conversationId: string,
  items: readonly MailboxPostItem[]
): Promise<number> {
  if (items.length === 0) return 0;
  const token = getMyGroupToken(conversationId);
  if (!token) return 0;

  let written = 0;
  for (let i = 0; i < items.length; i += MAILBOX_MAX_ITEMS_PER_POST) {
    const chunk = items.slice(i, i + MAILBOX_MAX_ITEMS_PER_POST);
    const res = await api<{ written?: number }>(
      `/api/groups/${encodeURIComponent(conversationId)}/mailbox`,
      { method: 'POST', body: JSON.stringify({ token, items: chunk }), timeoutMs: 15_000, anonymous: true }
    );
    written += Number(res?.written ?? 0);
  }
  return written;
}

/** Bentuk minimal envelope distribusi yang dibutuhkan untuk di-address & dikirim. */
export interface KeyEnvelopeInput {
  userId: string;
  key: string;
  /** Identity key perangkat target — membedakan device satu user (satu tag). */
  targetDeviceKey?: string;
  senderId?: string;
  senderDeviceKey?: string;
  senderSigningKey?: string;
  senderSigningKeyV2?: string;
}

/**
 * Post envelope kunci grup ke mailbox, satu item per penerima dengan tag
 * alamatnya. Mengembalikan himpunan `userId` yang **benar-benar** terkirim;
 * pemanggil mengirim sisanya lewat jalur lama (mis. saat metadata/token belum
 * tersedia — createGroup sebelum metadata masuk store).
 */
export async function postGroupKeyEnvelopes (
  conversationId: string,
  envelopes: readonly KeyEnvelopeInput[]
): Promise<Set<string>> {
  const delivered = new Set<string>();
  if (envelopes.length === 0) return delivered;

  const tokenMap = getDeliveryTokenMap(conversationId);
  // Tanpa group token atau peta token anggota, item tidak bisa ditulis/dialamatkan.
  if (!tokenMap || !getMyGroupToken(conversationId)) return delivered;

  const items: MailboxPostItem[] = [];
  for (const envelope of envelopes) {
    if (!envelope.userId || !envelope.key) continue;
    const tag = await deriveMailboxTag(tokenMap[envelope.userId]);
    if (!tag) continue;
    const payload = encodeMailboxPayload({
      k: envelope.key,
      // Hint perangkat: satu user bisa punya >1 device dengan tag yang SAMA,
      // dan envelope hanya bisa dibuka oleh device yang di-seal. Tanpa hint,
      // device lain akan gagal unseal (dan mengirim permintaan kunci palsu).
      t: envelope.targetDeviceKey,
      sp: envelope.senderId,
      sd: envelope.senderDeviceKey,
      ss: envelope.senderSigningKey,
      ss2: envelope.senderSigningKeyV2,
    });
    if (!payload) continue;
    items.push({ kind: 'KEY_ENVELOPE', tag, payload });
    delivered.add(envelope.userId);
  }
  if (items.length === 0) return delivered;

  try {
    const written = await postGroupMailboxItems(conversationId, items);
    if (written < items.length) {
      // Server menulis per item; batch yang ditolak sebagian tidak boleh
      // dianggap terkirim (penerima akan menunggu kunci selamanya).
      console.warn(`[Mailbox] ${conversationId}: hanya ${written}/${items.length} item tertulis`);
      return new Set();
    }
  } catch (error) {
    console.warn('[Mailbox] Post envelope gagal, memakai jalur lama:', error);
    return new Set();
  }
  return delivered;
}

// --- Pull ---

export async function pullGroupMailbox (
  conversationId: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<MailboxPullPage | null> {
  // Setelah rotasi, token grup lama sudah mati tetapi member token masih sah.
  // Fallback ini yang membuat anggota offline bisa menarik KEY_ENVELOPE era baru.
  const token = getMyGroupToken(conversationId) ?? getMyDeliveryToken(conversationId);
  if (!token) return null;

  type RawPage = { epoch?: number; items?: MailboxItem[]; nextCursor?: string | null; truncated?: boolean };
  let page: RawPage;
  try {
    page = await api<RawPage>(
      `/api/groups/${encodeURIComponent(conversationId)}/mailbox/pull`,
      {
        method: 'POST',
        body: JSON.stringify({
          token,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        }),
        timeoutMs: 15_000,
        anonymous: true,
      }
    );
  } catch (error) {
    // 403/404 = token era lama (rotasi belum sampai ke metadata kita) atau grup
    // sudah tidak ada; 429 = rate limit. Ketiganya pulih sendiri, jadi bukan
    // alasan untuk membanjiri konsol tiap tick.
    const status = (error as { status?: number }).status;
    if (status === 403 || status === 404 || status === 429) return null;
    throw error;
  }

  return {
    epoch: Number(page?.epoch ?? 0),
    items: Array.isArray(page?.items) ? page.items : [],
    nextCursor: typeof page?.nextCursor === 'string' ? page.nextCursor : null,
    truncated: page?.truncated === true,
  };
}

// --- Proses (terima) ---

/** Cursor per percakapan; hilang saat reload dan itu aman (pull era berjalan). */
const cursors = new Map<string, string>();
/** Id item yang sudah diproses — `storeReceivedSessionKey` idempoten, ini hanya hemat kerja. */
const processed = new Set<string>();

/** Batas halaman per panggilan supaya satu tick tidak berubah jadi loop panjang. */
const MAX_PAGES_PER_TICK = 5;

/** Identity key (base64url) perangkat ini, untuk memilih envelope yang benar. */
async function getMyDeviceIdentityKey (): Promise<string | undefined> {
  try {
    const [{ getMyEncryptionKeyPair }, { getSodium }] = await Promise.all([
      import('@utils/crypto'),
      import('@lib/sodiumInitializer'),
    ]);
    const sodium = await getSodium();
    const { publicKey } = await getMyEncryptionKeyPair();
    return sodium.to_base64(publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    return undefined;
  }
}

/** Hanya untuk test. */
export function resetGroupMailboxStateForTests (): void {
  cursors.clear();
  processed.clear();
}

/**
 * Ambil item mailbox untuk satu grup dan teruskan envelope kunci ke jalur
 * dekripsi yang sudah ada (`storeReceivedSessionKey` — verifikasi envelope v2/v4,
 * anchoring era, arsip multi-era). Mengembalikan jumlah envelope yang diproses.
 */
export async function processGroupMailbox (conversationId: string): Promise<number> {
  const myTag = await deriveMailboxTag(getMyDeliveryToken(conversationId));
  let handled = 0;

  for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_TICK; pageIndex += 1) {
    const cursor = cursors.get(conversationId);
    const page = await pullGroupMailbox(conversationId, cursor ? { cursor } : {});
    if (!page) return handled;

    for (const item of page.items) {
      if (processed.has(item.id)) continue;
      processed.add(item.id);
      if (item.kind !== 'KEY_ENVELOPE') continue;
      // Tag lain = milik anggota lain (ciphertext-nya tetap tidak bisa kami buka).
      if (item.tag && item.tag !== myTag) continue;

      const envelope = decodeMailboxPayload<{
        k?: string;
        t?: string;
        sp?: string;
        sd?: string;
        ss?: string;
        ss2?: string;
      }>(item.payload);
      if (!envelope?.k || !envelope.sp) continue;
      // Item untuk device lain milik user yang sama (tag identik).
      if (envelope.t && envelope.t !== await getMyDeviceIdentityKey()) continue;

      try {
        const { storeReceivedSessionKey } = await import('@utils/crypto');
        await storeReceivedSessionKey({
          conversationId,
          encryptedKey: envelope.k,
          type: 'GROUP_KEY',
          senderId: envelope.sp,
          senderDeviceKey: envelope.sd,
          senderSigningKey: envelope.ss,
          senderSigningKeyV2: envelope.ss2,
        });
        handled += 1;
      } catch (error) {
        // Satu envelope rusak tidak boleh menghentikan item lain di halaman ini.
        console.warn('[Mailbox] Envelope kunci gagal diproses:', error);
      }
    }

    if (page.nextCursor) cursors.set(conversationId, page.nextCursor);
    if (!page.truncated) break;
  }

  return handled;
}

export interface GroupMailboxLoopOptions {
  intervalMs?: number;
  /** Ambil daftar grup aktif — di-inject supaya loop bisa diuji tanpa store. */
  listGroups?: () => string[] | Promise<string[]>;
  process?: (conversationId: string) => Promise<unknown>;
}

/**
 * Poll mailbox untuk semua grup selama sesi terbuka. Satu tick pada satu waktu,
 * gagal pada satu grup tidak menghentikan grup lain, `stop()` idempoten.
 */
export function startGroupMailboxLoop (options: GroupMailboxLoopOptions = {}): () => void {
  const intervalMs = Math.max(2_000, options.intervalMs ?? MAILBOX_POLL_INTERVAL_MS);
  const process = options.process ?? processGroupMailbox;
  // Impor dinamis: modul ini dipakai jalur kirim/terima kunci yang sudah memuat
  // store, tapi test tidak boleh ikut menarik seluruh graph store.
  const listGroups = options.listGroups ?? (async () => {
    const { useConversationStore } = await import('@store/conversation');
    return useConversationStore
      .getState()
      .conversations
      .filter((conversation) => conversation.isGroup)
      .map((conversation) => conversation.id);
  });

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (const conversationId of await listGroups()) {
        if (stopped) break;
        try {
          await process(conversationId);
        } catch (error) {
          console.warn(`[Mailbox] Poll gagal untuk ${conversationId}:`, error);
        }
      }
    } finally {
      running = false;
      schedule(intervalMs);
    }
  };

  schedule(1_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
