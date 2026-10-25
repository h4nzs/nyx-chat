// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.4 P8] Jitter rilis pesan grup di server.
 *
 * Kenapa: relay yang meneruskan pesan tepat saat diterima memberi pengamat
 * jaringan (atau operator relay) sidik jari waktu kirim yang bisa dipakai
 * mengorelasikan pesan dengan aktivitas pengirim. Dengan jitter acak 0..N ms,
 * pesan grup yang menumpuk di jam sibuk menyebar, dan pengamat tidak bisa
 * menyimpulkan "kirim jam 12:00:00.123" dari "terima jam 12:00:00.130".
 *
 * Aturan (jangan diubah tanpa membaca docs/26 §26.4/§26.8.3):
 *  - **Opt-in**, default MATI (`GROUP_RELEASE_JITTER_MS` kosong/0). Menyalakan
 *    ini menambah latensi pengiriman; itu keputusan operator, bukan default.
 *  - **Hanya grup** (`isGroup === true`). Pesan 1:1 sudah memakai cover traffic
 *    klien; menambah delay server di sana memboroskan UX tanpa manfaat.
 *  - **Tidak menyentuh isi**: padding 8 KB, envelope, dan header pesan tidak
 *    berubah. Yang ditunda hanya pemanggilan relay setelah ACK dikirim.
 *  - Clip keras `MAX_JITTER_MS`: nilai env yang salah (mis. 60000) tidak boleh
 *    membuat pesan tertahan satu menit.
 *
 * Batas jujur: ini bukan batching. Jitter menyebar **satu** pesan; ia tidak
 * menyembunyikan bahwa sebuah pesan dikirim, dan tidak menyamakan ukuran pesan.
 */

import { GROUP_RELEASE_DELAY_MS, observeHistogram } from './metrics.js';

export const MAX_JITTER_MS = 2_000;

/** Policy dari env. Nilai invalid/berlebih → clip, bukan crash. */
export function groupReleaseJitterMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.GROUP_RELEASE_JITTER_MS ?? '').trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), MAX_JITTER_MS);
}

export interface ReleaseJitterDeps {
  env?: NodeJS.ProcessEnv;
  /** Sumber acak (di-inject di tes supaya deterministik). */
  random?: () => number;
  /** Penunda (di-inject di tes supaya tidak benar-benar menunggu). */
  sleep?: (ms: number) => Promise<void>;
  /** Pengamat metrik (di-inject di tes). */
  observe?: (ms: number) => void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tunda rilis grup bila fitur hidup. Mengembalikan delay yang benar-benar
 * dipakai (ms) supaya pemanggil/tes bisa memeriksanya.
 *
 * Dipanggil SETELAH ACK ke pengirim: pengirim tidak boleh menunggu jitter, dan
 * jitter tidak boleh mengubah hasil penyimpanan pesan.
 */
export async function applyGroupReleaseJitter(
  isGroup: boolean,
  deps: ReleaseJitterDeps = {}
): Promise<number> {
  if (!isGroup) return 0;
  const maxMs = groupReleaseJitterMs(deps.env);
  if (maxMs <= 0) return 0;

  const random = deps.random ?? Math.random;
  // `Math.floor(random * (max + 1))` bisa menghasilkan max+1 bila random()→1;
  // clamp eksplisit supaya batas atas benar-benar batas.
  const delayMs = Math.min(maxMs, Math.floor(random() * (maxMs + 1)));
  // Histogram dalam milidetik — nama metrik menyebut satuannya.
  const observe = deps.observe ?? ((ms: number) => observeHistogram(GROUP_RELEASE_DELAY_MS, ms));
  observe(delayMs);
  if (delayMs > 0) {
    await (deps.sleep ?? realSleep)(delayMs);
  }
  return delayMs;
}
