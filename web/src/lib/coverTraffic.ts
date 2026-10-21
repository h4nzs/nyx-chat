// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [T4] Application-level cover traffic — doc 26.10 (blueprint).
 *
 * Pesan pengisi terenkripsi yang melewati pipeline PENUH (sendMessage →
 * sidecar → redisBridge → Postgres → penerima) lalu di-drop klien setelah
 * dekripsi (`silentPayload.type === 'COVER'` → null, seperti GHOST_SYNC).
 * Untuk semua lapisan di bawah crypto worker penerima, cover identik dengan
 * pesan nyata — hanya payload terenkripsinya yang berbeda.
 *
 * Scheduling: Poisson independen per percakapan (Δ = -ln(U)/λ, clamp
 * [10s, 15min]). Superposisi proses Poisson independen = Poisson, sehingga
 * pengiriman nyata bersembunyi TANPA koordinasi antar anggota. Cover TIDAK
 * ditekan setelah kirim nyata (silence/burst pattern adalah sinyal tersendiri
 * — independensi Poisson justru fiturnya, keputusan 26.10.3).
 *
 * Privacy: toggle per-grup = state LOKAL klien (server tidak boleh tahu
 * percakapan mana yang menjalankan cover — itu akan menandai pesan yang
 * justru ingin kita lindungi). Master kill-switch global, tanpa enumerasi.
 */

// λ default: satu cover / 2 menit / percakapan (26.10.3).
export const COVER_LAMBDA_PER_MIN = 0.5;
// Batas adaptive λ: di bawah 0.2 cover jadi terlalu jarang untuk menyamarkan
// burst; di atas 2.0 penghematan baterai/bandwidth habis (26.10.3).
export const COVER_LAMBDA_MIN = 0.2;
export const COVER_LAMBDA_MAX = 2.0;
// Clamp interval sesuai desain: [10s, 15min].
export const COVER_MIN_INTERVAL_MS = 10_000;
export const COVER_MAX_INTERVAL_MS = 15 * 60_000;

/** Sampel interval eksponensial (Poisson) dengan clamp [min, max]. */
export function samplePoissonInterval(lambdaPerMin: number, rng: () => number = Math.random): number {
  const u = rng();
  if (u <= 0) return COVER_MAX_INTERVAL_MS; // λ efektif → interval tak terhingga → clamp
  const ratePerMs = lambdaPerMin / 60_000;
  const raw = -Math.log(u) / ratePerMs;
  return Math.min(COVER_MAX_INTERVAL_MS, Math.max(COVER_MIN_INTERVAL_MS, raw));
}

/**
 * Backoff rate-limit (26.10.4): cover MELENDIR ke kirim nyata, tidak
 * sebaliknya. Scheduler menunda bila real sends + pending covers mendekati
 * bucket `chat_message` (30/min). Dipanggil sebelum mengirim cover.
 */
const recentSendTimestamps: number[] = [];
// [27.2.4] Server bucket naik ke 120/min (VPS baru). Soft cap cover tetap
// sedikit di bawah limit server; cover hanya perlu menjaga ~2 slot bebas —
// jangan sampai cover memenuhi bucket (cover yield ke real, 26.10.4).
const CHAT_MESSAGE_LIMIT_PER_MIN = 118; // margin 2 slot di bawah 120 server-side

// [docs/35 Fase 3] Laju nyata per percakapan untuk adaptive λ. Disimpan hanya
// di memori: tidak perlu bertahan reload, dan tidak boleh jadi jejak aktivitas
// yang menetap di disk.
const realSendsByConversation = new Map<string, number[]>();

function pruneConversationSends(list: number[], now: number): number[] {
  const cutoff = now - 60_000;
  let first = 0;
  while (first < list.length && (list[first] ?? Infinity) < cutoff) first += 1;
  return first === 0 ? list : list.slice(first);
}

export function notifyRealSend(now: number = Date.now(), conversationId?: string): void {
  recentSendTimestamps.push(now);
  pruneRecentSends(now);
  if (conversationId) {
    const list = pruneConversationSends(realSendsByConversation.get(conversationId) ?? [], now);
    list.push(now);
    realSendsByConversation.set(conversationId, list);
    // Batasi jumlah percakapan yang dilacak (burner/1:1 bisa banyak); entri
    // terlama tanpa aktivitas dibuang supaya memori tidak tumbuh selamanya.
    if (realSendsByConversation.size > 64) {
      const oldest = realSendsByConversation.keys().next().value;
      if (oldest !== undefined) realSendsByConversation.delete(oldest);
    }
  }
}

/** Laju kirim nyata percakapan ini dalam 60 detik terakhir (pesan/menit). */
export function realSendRatePerMin(conversationId: string, now: number = Date.now()): number {
  const list = realSendsByConversation.get(conversationId);
  if (!list || list.length === 0) return 0;
  const pruned = pruneConversationSends(list, now);
  realSendsByConversation.set(conversationId, pruned);
  return pruned.length;
}

/**
 * [docs/35 Fase 3] λ adaptif: cover mengikuti laju nyata supaya rasio
 * cover:nyata tetap ~1:2 pada percakapan aktif, tetapi tidak pernah turun di
 * bawah `COVER_LAMBDA_MIN` (percakapan sepi tetap punya denyut) dan tidak
 * melewati `COVER_LAMBDA_MAX` (baterai/bandwidth).
 */
export function adaptiveCoverLambda(
  realPerMin: number,
  base: number = COVER_LAMBDA_PER_MIN,
): number {
  if (!Number.isFinite(realPerMin) || realPerMin <= 0) return base;
  const blended = Math.max(base, realPerMin * 0.5);
  return Math.min(COVER_LAMBDA_MAX, Math.max(COVER_LAMBDA_MIN, blended));
}

function pruneRecentSends(now: number): void {
  const cutoff = now - 60_000;
  while (recentSendTimestamps.length > 0 && (recentSendTimestamps[0] ?? Infinity) < cutoff) {
    recentSendTimestamps.shift();
  }
}

/** true = cover BOLEH dikirim (bucket longgar); false = tunda. */
export function coverShouldYield(now: number = Date.now()): boolean {
  pruneRecentSends(now);
  return recentSendTimestamps.length >= CHAT_MESSAGE_LIMIT_PER_MIN - 2;
}

/**
 * [26.10.5 Q5] Burner default Maximum: setiap percakapan dengan prefix
 * `burner_` di-arm otomatis tanpa opt-in eksplisit dan TANPA persist ke
 * settings store — status Maximum burner bersifat derivatif (client-local,
 * server tetap tidak pernah tahu). Master kill-switch tetap menang.
 */
export const BURNER_CONVERSATION_PREFIX = 'burner_';

export function isBurnerConversation(conversationId: string): boolean {
  return conversationId.startsWith(BURNER_CONVERSATION_PREFIX);
}

/**
 * [docs/35 Fase 3] Bolehkah cover dikirim ke percakapan ini?
 *
 * Grup dan burner: ya (perilaku lama). Chat 1:1 biasa: hanya setelah ada pesan
 * nyata (`hasHistory`) — cover tidak boleh menjadi pemicu handshake/percakapan
 * baru, karena itu justru menciptakan metadata yang ingin disembunyikan.
 */
export function coverTargetAllowed(input: {
  conversationId: string;
  isGroup: boolean;
  hasHistory: boolean;
}): boolean {
  if (isBurnerConversation(input.conversationId)) return true;
  if (input.isGroup) return true;
  return input.hasHistory;
}

/**
 * Gabungan conversation ids yang harus di-arm scheduler: grup Maximum
 * eksplisit (settings store) + semua burner yang diketahui conversation
 * store (26.10.5 Q5). Dedupe mempertahankan urutan (grup dulu, burner belakangan).
 */
export function collectCoverArmedIds(
  maximumGroups: Iterable<string>,
  conversations: Iterable<{ id: string }>,
): string[] {
  const ids: string[] = [];
  for (const id of maximumGroups) {
    if (!ids.includes(id)) ids.push(id);
  }
  for (const conv of conversations) {
    if (typeof conv.id === 'string' && isBurnerConversation(conv.id) && !ids.includes(conv.id)) {
      ids.push(conv.id);
    }
  }
  return ids;
}

/**
 * Deteksi payload COVER dari konten yang SUDAH didekripsi. Dipakai jalur
 * burner DR (receiveMessage) yang tidak lewat parseSilent message store —
 * tanpa ini, cover burner akan muncul sebagai bubble JSON mentah.
 */
export function isCoverPayload(content: string): boolean {
  if (typeof content !== 'string' || !content.startsWith('{')) return false;
  try {
    return (JSON.parse(content) as { type?: unknown }).type === 'COVER';
  } catch {
    return false;
  }
}

/** Hanya untuk test — kosongkan riwayat real-send + laju per percakapan. */
export function _resetCoverTrafficStateForTests(): void {
  recentSendTimestamps.length = 0;
  realSendsByConversation.clear();
}

export interface CoverTrafficPreferences {
  /** Master kill-switch: false → tidak pernah kirim cover apa pun. */
  masterEnabled: boolean;
  /** Conversation IDs dengan privacy level Maximum (client-local). */
  maximumGroups: Set<string>;
  /** Injected dependencies (testable). */
  now?: () => number;
  isVisible?: () => boolean;
  isTransportConnected?: () => boolean;
  onSendCover?: (conversationId: string) => void;
  /** λ per percakapan (adaptive). Default: adaptive dari laju nyata. */
  lambdaFor?: (conversationId: string, now: number) => number;
  /** Budget byte harian; default dibuat lazy dari localStorage. */
  budget?: CoverBudget;
  /** Ukuran amplop yang dihitung ke budget (8KB padding). */
  envelopeBytes?: number;
}

// ───────────────────────── Budget byte harian ─────────────────────────

export const COVER_BUDGET_STORAGE_KEY = 'nyx_cover_budget_v1';
/**
 * Default per percakapan per hari: λ=0.5/menit × 8 KB ≈ 5.8 MB; 25 MB memberi
 * ruang untuk burst tanpa membuat "Maximum" jadi tombol pembakar kuota.
 */
export const COVER_DAILY_BUDGET_BYTES = 25 * 1024 * 1024;

export interface CoverBudgetSnapshot {
  day: string;
  used: Record<string, number>;
}

function budgetDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function readBudget(storage: Pick<Storage, 'getItem'> | null, now: number): CoverBudgetSnapshot {
  const empty: CoverBudgetSnapshot = { day: budgetDay(now), used: {} };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(COVER_BUDGET_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return empty;
    const { day, used } = parsed as { day?: unknown; used?: unknown };
    if (typeof day !== 'string' || day !== budgetDay(now)) return empty;
    if (!used || typeof used !== 'object' || Array.isArray(used)) return empty;
    const clean: Record<string, number> = {};
    for (const [id, value] of Object.entries(used as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[id] = value;
    }
    return { day, used: clean };
  } catch {
    return empty;
  }
}

/**
 * Budget byte cover harian (client-local, reset per hari UTC).
 *
 * Kenapa perlu: λ adaptif pada percakapan ramai bisa menaikkan volume beberapa
 * kali lipat; tanpa plafon, "Maximum" berubah jadi penguras kuota data yang
 * tidak terlihat. Budget dihitung konservatif (per fire, bukan per sukses).
 */
export class CoverBudget {
  private snapshot: CoverBudgetSnapshot;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly now: () => number;
  private readonly dailyBytes: number;

  constructor(options: {
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
    now?: () => number;
    dailyBytes?: number;
  } = {}) {
    this.storage = options.storage ?? defaultStorage();
    this.now = options.now ?? Date.now;
    this.dailyBytes = options.dailyBytes ?? COVER_DAILY_BUDGET_BYTES;
    this.snapshot = readBudget(this.storage, this.now());
  }

  usedToday(conversationId: string): number {
    this.rolloverIfNeeded();
    return this.snapshot.used[conversationId] ?? 0;
  }

  remaining(conversationId: string): number {
    return Math.max(0, this.dailyBytes - this.usedToday(conversationId));
  }

  canSend(conversationId: string, bytes: number = 8192): boolean {
    return this.remaining(conversationId) >= bytes;
  }

  record(conversationId: string, bytes: number = 8192): void {
    this.rolloverIfNeeded();
    this.snapshot.used[conversationId] = (this.snapshot.used[conversationId] ?? 0) + bytes;
    this.persist();
  }

  private rolloverIfNeeded(): void {
    const today = budgetDay(this.now());
    if (this.snapshot.day !== today) {
      this.snapshot = { day: today, used: {} };
      this.persist();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(COVER_BUDGET_STORAGE_KEY, JSON.stringify(this.snapshot));
    } catch {
      // Quota penuh / storage diblokir: budget jadi in-memory saja. Jangan
      // sampai kegagalan menulis storage mematikan cover traffic.
    }
  }
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Scheduler Poisson independen per percakapan. Satu instance global; interval
 * di-resample setelah tiap fire (memoryless). Hanya fires bila:
 *  - tab visible / app memegang koneksi WT (tab background jangan dikorelasikan
 *    dengan perhatian user — 26.10.3), dan
 *  - transport connected, dan
 *  - master switch on, dan conversation opted-in.
 */
export class CoverTrafficScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly prefs: Required<Omit<CoverTrafficPreferences, 'maximumGroups' | 'masterEnabled'>> &
    Pick<CoverTrafficPreferences, 'maximumGroups' | 'masterEnabled'>;

  constructor(prefs: CoverTrafficPreferences) {
    const now = prefs.now ?? Date.now;
    this.prefs = {
      now,
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      isTransportConnected: () => false,
      onSendCover: () => {},
      lambdaFor: (conversationId, at) => adaptiveCoverLambda(realSendRatePerMin(conversationId, at)),
      budget: new CoverBudget({ now }),
      envelopeBytes: 8192,
      ...prefs,
    };
  }

  updatePreferences(partial: Partial<CoverTrafficPreferences>): void {
    Object.assign(this.prefs, partial);
    // Master switch off → hentikan semua timer.
    if (this.prefs.masterEnabled === false) this.stopAll();
  }

  /** Mulai scheduling untuk satu percakapan (idempoten). */
  start(conversationId: string): void {
    if (this.timers.has(conversationId)) return;
    this.scheduleNext(conversationId);
  }

  /** Berhenti untuk satu percakapan (opt-out / keluar grup). */
  stop(conversationId: string): void {
    const t = this.timers.get(conversationId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(conversationId);
    }
  }

  stopAll(): void {
    for (const id of Array.from(this.timers.keys())) this.stop(id);
  }

  /** Sinkronkan timer dengan daftar percakapan Maximum saat ini. */
  sync(conversationIds: Iterable<string>): void {
    const wanted = new Set(conversationIds);
    for (const id of Array.from(this.timers.keys())) {
      if (!wanted.has(id)) this.stop(id);
    }
    if (this.prefs.masterEnabled) {
      for (const id of wanted) this.start(id);
    }
  }

  private scheduleNext(conversationId: string): void {
    const lambda = this.prefs.lambdaFor(conversationId, this.prefs.now());
    const interval = samplePoissonInterval(lambda);
    const t = setTimeout(() => {
      this.timers.delete(conversationId);
      this.fireIfEligible(conversationId);
      // Lanjutkan scheduling hanya bila masih opted-in.
      if (this.isOptedIn(conversationId)) this.scheduleNext(conversationId);
    }, interval);
    this.timers.set(conversationId, t);
  }

  private isOptedIn(conversationId: string): boolean {
    if (this.prefs.masterEnabled !== true) return false;
    // [26.10.5 Q5] Burner default Maximum — selalu opted-in (master menang).
    if (isBurnerConversation(conversationId)) return true;
    return this.prefs.maximumGroups.has(conversationId);
  }

  private fireIfEligible(conversationId: string): void {
    if (!this.isOptedIn(conversationId)) return;
    // Tab background / transport putus → skip tick ini (jangan antri; resample
    // saja saat kondisi kembali memenuhi — memoryless).
    if (!this.prefs.isVisible() || !this.prefs.isTransportConnected()) return;
    // Rate-limit backoff: cover yield ke real (26.10.4).
    if (coverShouldYield(this.prefs.now())) return;
    // Budget harian habis → berhenti sampai besok (bukan menurunkan λ diam-diam;
    // user melihat estimasi di UI dan bisa mematikan Maximum).
    const envelopeBytes = this.prefs.envelopeBytes;
    if (this.prefs.budget && !this.prefs.budget.canSend(conversationId, envelopeBytes)) return;
    this.prefs.onSendCover(conversationId);
    // Dihitung per fire (konservatif): cover yang gagal kirim tetap memakai
    // jatah, sehingga budget tidak bisa dipakai untuk burst tak terbatas.
    this.prefs.budget?.record(conversationId, envelopeBytes);
  }
}

/** Kontrak pengiriman dipisah agar store bisa menyuntik implementasinya. */
export function makeCoverContent(): string {
  return JSON.stringify({ type: 'COVER', ts: Date.now() });
}

/** Estimasi konsumsi data per hari untuk UI (26.10.5) — jujur, tanpa silent burn. */
export function estimateDailyCoverBytes(lambdaPerMin: number = COVER_LAMBDA_PER_MIN, envelopeBytes: number = 8192): number {
  return Math.round(lambdaPerMin * 60 * 24 * envelopeBytes);
}

// --- Singleton global (client-local; server tidak pernah tahu) ---
let globalScheduler: CoverTrafficScheduler | null = null;

/**
 * Scheduler global. `onSendCover` disuntik oleh pemanggil pertama (App-level)
 * agar tidak ada circular import dengan store/message. Status koneksi dibaca
 * lazy (setiap fire), bukan saat konstruksi — aman terhadap urutan import.
 */
export function getCoverScheduler(onSendCover?: (conversationId: string) => void): CoverTrafficScheduler {
  if (!globalScheduler) {
    globalScheduler = new CoverTrafficScheduler({
      masterEnabled: true,
      maximumGroups: new Set<string>(),
      isTransportConnected: () => {
        // Dynamic read lewat `globalThis`: menghindari circular dependency statis.
        try {
          const store = (globalThis as { __nyx_connection_probe?: () => string }).__nyx_connection_probe;
          return store ? store() === 'connected' : false;
        } catch {
          return false;
        }
      },
      onSendCover: onSendCover ?? (() => {}),
    });
  } else if (onSendCover) {
    globalScheduler.updatePreferences({ onSendCover });
  }
  return globalScheduler;
}
