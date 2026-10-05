// ============================================================================
// [CONTACT STORE — P1 2026-10-05]
// Daftar "user yang pernah bertukar pesan dengan saya" — entitas PERSISTEN.
//
// Sebelumnya kontak murni derivasi runtime dari `conversations.participants`
// (Opaque Mailbox: server menyimpan participants kosong), dengan tiga akibat:
//   1. Reinstall / device baru → daftar kosong sampai pesan baru datang.
//   2. Pesan TTL 14 hari habis → identitas peer hilang permanen.
//   3. Tiga rumusan derive Participant (id | userId | user.id) tersebar di UI.
//
// Solusi (mengadopsi pola Signal — Storage Service + Contact model):
//   • Lokal  : tabel Dexie `contacts` (db.ts) — kolom `data` berisi JSON
//              ContactRecord TERENKRIPSI via encryptVaultText (kunci
//              deterministik dari identity private key → bisa didekripsi
//              kembali di device mana pun yang me-restore identity key).
//   • Server : SATU blob opaque per user (users.encryptedContactBundle).
//              Server tidak bisa membaca isinya (zero-knowledge tetap utuh);
//              kolom plain hanya version + updatedAt untuk fetch kondisional.
//              Format bundle dibekukan: shared ContactBundle v1.
//
// Prinsip kegagalan: fail-open ke data lokal. Bundle korup/parse gagal TIDAK
// boleh menghapus kontak lokal.
// ============================================================================

import { db } from './db';
import type { ContactRow } from './db';
import {
    asUserId,
    getParticipantUserId,
    parseContactBundle,
    serializeContactBundle,
    type ContactRecord,
    type Conversation,
} from '@nyx/shared';
import { encryptVaultText, decryptVaultText } from './shadowVaultDb';

const BUNDLE_VERSION_KEY = 'contact_bundle_version';

// ─── helpers ────────────────────────────────────────────────────────────────

/** userId yang layak masuk contact store (bukan system/burner/guest). */
function isPersistableUserId(userId: string): boolean {
    return (
        userId.length > 0 &&
        userId !== 'nyx_system_id' &&
        !userId.startsWith('guest_') &&
        !userId.startsWith('burner_')
    );
}

async function encryptRecord(record: ContactRecord): Promise<string> {
    return encryptVaultText(JSON.stringify(record));
}

async function decryptRow(row: ContactRow): Promise<ContactRecord | null> {
    const plain = await decryptVaultText(row.data);
    if (!plain) return null; // korup / kunci lama — skip, jangan crash
    try {
        const parsed = JSON.parse(plain) as Partial<ContactRecord>;
        if (typeof parsed.userId !== 'string' || parsed.userId.length === 0) return null;
        return {
            userId: parsed.userId,
            conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : null,
            encryptedProfile: typeof parsed.encryptedProfile === 'string' ? parsed.encryptedProfile : null,
            publicKey: typeof parsed.publicKey === 'string' ? parsed.publicKey : undefined,
            firstSeenAt: typeof parsed.firstSeenAt === 'number' ? parsed.firstSeenAt : row.updatedAt,
            lastSeenAt: typeof parsed.lastSeenAt === 'number' ? parsed.lastSeenAt : row.updatedAt,
            alias: typeof parsed.alias === 'string' ? parsed.alias : undefined,
            blocked: parsed.blocked === true,
        };
    } catch {
        return null;
    }
}

function nowMs(): number {
    return Date.now();
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/** Upsert satu kontak. Merge non-destruktif: field lama dipertahankan bila baru kosong. */
export async function upsertContact(input: {
    userId: string;
    conversationId?: string | null;
    encryptedProfile?: string | null;
    publicKey?: string;
    alias?: string;
    blocked?: boolean;
}): Promise<void> {
    if (!isPersistableUserId(input.userId)) return;
    const userId = asUserId(input.userId);
    const now = nowMs();

    const existing = await db.contacts.get(userId);
    const prev = existing ? await decryptRow(existing) : null;

    const record: ContactRecord = {
        userId,
        // conversationId: pertahankan yang lama bila input tidak membawa baru.
        conversationId: input.conversationId ?? prev?.conversationId ?? null,
        encryptedProfile: input.encryptedProfile ?? prev?.encryptedProfile ?? null,
        publicKey: input.publicKey ?? prev?.publicKey,
        alias: input.alias ?? prev?.alias,
        blocked: input.blocked ?? prev?.blocked ?? false,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
    };

    await db.contacts.put({
        userId,
        data: await encryptRecord(record),
        updatedAt: now,
    });

    void scheduleContactBundlePush();
}

/** Tandai block/unblock tanpa menyentuh field lain. */
export async function setContactBlocked(userId: string, blocked: boolean): Promise<void> {
    if (!isPersistableUserId(userId)) return;
    await upsertContact({ userId, conversationId: null, blocked });
}

/** Hapus satu kontak (dipakai wipe/nuke; TIDAK otomatis saat delete conv — kontak boleh survive). */
export async function deleteContact(userId: string): Promise<void> {
    await db.contacts.delete(asUserId(userId));
    void scheduleContactBundlePush();
}

/** Semua kontak terdekripsi (terbaru lastSeenAt dulu). */
export async function getAllContacts(): Promise<ContactRecord[]> {
    const rows = await db.contacts.toArray();
    const records = await Promise.all(rows.map(decryptRow));
    return records
        .filter((r): r is ContactRecord => r !== null)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Kontak yang tidak diblokir — pemakaian: picker story/grup. */
export async function getActiveContacts(): Promise<ContactRecord[]> {
    const all = await getAllContacts();
    return all.filter(c => !c.blocked);
}

export async function getContact(userId: string): Promise<ContactRecord | null> {
    const row = await db.contacts.get(asUserId(userId));
    if (!row) return null;
    return decryptRow(row);
}

// ─── Seed dari conversations (jalur warming) ────────────────────────────────

/**
 * Sinkronkan contact store dari daftar percakapan 1:1 — dipanggil setelah
 * loadConversations / addIncomingMessage. Merge-only: tidak pernah menghapus,
 * tidak pernah menurunkan lastSeenAt.
 */
export async function seedContactsFromConversations(conversations: Conversation[]): Promise<void> {
    const { useAuthStore } = await import('@store/auth');
    const meId = useAuthStore.getState().user?.id;
    if (!meId) return;

    const updates: Array<Parameters<typeof upsertContact>[0]> = [];
    for (const conv of conversations) {
        if (conv.isGroup || conv.id.startsWith('burner_')) continue;
        for (const p of conv.participants) {
            const uid = getParticipantUserId(p);
            if (!uid || uid === meId || !isPersistableUserId(uid)) continue;
            updates.push({
                userId: uid,
                conversationId: conv.id,
                encryptedProfile: p.encryptedProfile ?? null,
                publicKey: p.publicKey,
            });
        }
    }
    // Serial: semua menulis ke tabel sama + push bundle (debounced di dalam).
    for (const u of updates) {
        await upsertContact(u);
    }
}

/**
 * Rekonstruksi participants percakapan 1:1 DARI contact store — dipakai saat
 * conversation hadir tanpa participants (server-only / device baru / pesan
 * pertama belum tiba). Menggantikan kebutuhan menunggu pesan pertama.
 */
export async function buildPeerParticipantsFromContacts(conversationId: string): Promise<Array<{ id: ReturnType<typeof asUserId>; name: string; encryptedProfile: string | null; role: 'MEMBER' }>> {
    const contacts = await getAllContacts();
    const peers = contacts.filter(c => c.conversationId === conversationId);
    if (peers.length === 0) return [];
    const { useAuthStore } = await import('@store/auth');
    const meId = useAuthStore.getState().user?.id;
    return peers
        .filter(c => c.userId !== meId)
        .map(c => ({
            id: asUserId(c.userId),
            name: '',
            encryptedProfile: c.encryptedProfile ?? null,
            role: 'MEMBER' as const,
        }));
}

// ─── Backup blob opaque ke server ───────────────────────────────────────────

let bundlePushTimer: ReturnType<typeof setTimeout> | null = null;
let lastPushedVersion = 0;
let pushInFlight: Promise<void> | null = null;

/**
 * Push debounced (10s) — menulis ulang blob hanya bila isi berubah.
 * Gagal push TIDAK fatal (backup adalah best-effort; lokal tetap sumber
 * kebenaran sampai push sukses).
 */
export function scheduleContactBundlePush(): void {
    if (bundlePushTimer) clearTimeout(bundlePushTimer);
    bundlePushTimer = setTimeout(() => {
        bundlePushTimer = null;
        void pushContactBundle();
    }, 10_000);
}

export async function pushContactBundle(): Promise<void> {
    if (pushInFlight) return pushInFlight;
    pushInFlight = (async () => {
        try {
            const contacts = await getAllContacts();
            if (contacts.length === 0) return;
            const bundleJson = serializeContactBundle(contacts);
            let version = await computeBundleVersion(bundleJson);
            // Belt & suspenders: versi harus aman untuk Zod (safe int) DAN
            // kolom Postgres Int (2^31-1) — jangan pernah kirim nilai liar.
            if (!Number.isSafeInteger(version) || version < 0) version = hashFallback(bundleJson);
            if (version === lastPushedVersion) return;

            const { authFetch } = await import('@lib/api');
            await authFetch('/api/users/me/contact-bundle', {
                method: 'PUT',
                body: JSON.stringify({
                    encryptedBundle: await encryptVaultText(bundleJson),
                    version
                }),
            });
            lastPushedVersion = version;
        } catch (e) {
            console.warn('[ContactStore] Bundle push gagal (akan diulang saat perubahan berikutnya):', e);
        } finally {
            pushInFlight = null;
        }
    })();
    return pushInFlight;
}

/**
 * Versi = hash isi bundle (bukan counter) — dua device menulis isi sama
 * menghasilkan version sama → fetch kondisional server mengembalikan 304-ish
 * (null) tanpa transfer blob.
 */
async function computeBundleVersion(bundleJson: string): Promise<number> {
    const sodium = await (await import('@lib/sodiumInitializer')).getSodium();
    if (!sodium) return hashFallback(bundleJson);
    // VERSI = HASH 31-BIT (bukan counter, bukan 63/64-bit):
    //   • Server memvalidasi `version` via Zod int (JS safe int) dan menyimpan
    //     ke kolom Prisma `Int?` (Postgres INTEGER, max 2^31-1) — versi 63-bit
    //     lolos Zod pun tetap meledak saat prisma.user.update.
    //   • Anti-echo (version-hash guard) tak butuh ruang besar: collision dua
    //     isi berbeda per-user nyaris mustahil, dan efeknya hanya skip satu
    //     push (perubahan berikutnya memicu push lagi).
    //   • Rentang harus SAMA dengan hashFallback (FNV-1a 32-bit unsigned →
    //     dipotong 31-bit) agar jalur sodium↔fallback tidak mengubah nilai
    //     version untuk isi bundle yang sama.
    const bytes = sodium.crypto_generichash(8, sodium.from_string(bundleJson));
    const view = new DataView(bytes.buffer);
    return Number(view.getBigUint64(0) & 0x7fffffffn); // 31 bit
}

function hashFallback(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h & 0x7fffffff; // potong ke 31 bit — sejalan jalur sodium
}

/**
 * Pull bundle dari server saat startup — hanya mengisi kontak yang BELUM ada
 * lokal (server = backup, lokal = sumber kebenaran). Return jumlah kontak baru.
 */
export async function restoreContactsFromBundle(): Promise<number> {
    try {
        const { authFetch } = await import('@lib/api');
        const res = await authFetch<{ encryptedBundle: string | null } | null>('/api/users/me/contact-bundle');
        if (!res?.encryptedBundle) return 0;

        const bundleJson = await decryptVaultText(res.encryptedBundle);
        if (!bundleJson) return 0;
        const bundle = parseContactBundle(bundleJson);
        if (!bundle) {
            console.warn('[ContactStore] Bundle korup/tak dikenal — kontak lokal dipertahankan');
            return 0;
        }

        const known = new Set((await db.contacts.toArray()).map(r => String(r.userId)));
        const now = nowMs();
        let added = 0;
        for (const c of bundle.contacts) {
            if (known.has(c.userId)) continue; // lokal menang
            await db.contacts.put({
                userId: asUserId(c.userId),
                data: await encryptRecord(c),
                updatedAt: now,
            });
            added++;
        }
        return added;
    } catch (e) {
        console.warn('[ContactStore] Bundle restore gagal:', e);
        return 0;
    }
}

/** Hapus backup (nuke/wipe). Dipanggil jalur nuke — bukan penghapusan biasa. */
export async function wipeContactBackup(): Promise<void> {
    try {
        const { authFetch } = await import('@lib/api');
        await authFetch('/api/users/me/contact-bundle', { method: 'DELETE' });
    } catch (_e) { /* best-effort */ }
    await db.contacts.clear();
    lastPushedVersion = 0;
}

/** Versi bundle terakhir yang diketahui (diagnostik). */
export function getLastPushedVersion(): number {
    return lastPushedVersion;
}

// Re-export untuk pemakai lama yang mengimpor dari sini.
export { serializeContactBundle, parseContactBundle };
export type { ContactRecord };
