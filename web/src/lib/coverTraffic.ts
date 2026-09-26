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
const CHAT_MESSAGE_LIMIT_PER_MIN = 28; // sedikit di bawah 30 server-side — margin

export function notifyRealSend(now: number = Date.now()): void {
  recentSendTimestamps.push(now);
  pruneRecentSends(now);
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

/** Hanya untuk test — kosongkan riwayat real-send (state modul). */
export function _resetCoverTrafficStateForTests(): void {
  recentSendTimestamps.length = 0;
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
    this.prefs = {
      now: Date.now,
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      isTransportConnected: () => false,
      onSendCover: () => {},
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
    const interval = samplePoissonInterval(COVER_LAMBDA_PER_MIN);
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
    this.prefs.onSendCover(conversationId);
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
        // Dynamic read + dynamic import: menghindari circular dependency statis.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
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
