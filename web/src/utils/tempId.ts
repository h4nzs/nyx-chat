// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Generator tempId tahan collision antar-tab [Temuan #3].
 *
 * Kontrak tempId (jangan diubah ringannya):
 *  - `number` bulat (schema server: `z.number().int()`), JS-safe (≤ 2^53-1).
 *  - Dipakai ulang APA ADANYA saat retry (retrySendMessage / offline queue) —
 *    dedupe server `nyx:send_dedupe:{deviceId}:{tempId}` mengandalkan itu.
 *  - Nilai lama masih valid selamanya (tidak ada batas waktu), jadi skema baru
 *    ini tidak perlu migrasi — hanya mencegah collision ke depan.
 *
 * Skema lama: `Date.now() * 1000 + counter + random(0..999)`.
 *   - Dua tab yang membangun pesan di milidetik yang sama + counter yang sama
 *     (keduanya mulai dari 0 saat halaman dimuat) bisa menghasilkan tempId
 *     identik. Dengan dedupe server per (deviceId, tempId), tab B yang kebetulan
 *     menabrak tab A mengirim pesan kedua → dianggap duplikat → di-ACK dengan
 *     pesan A dan pesan B HILANG untuk penerima. Sangat jarang, tapi fatal.
 *   - Ditambah `Math.random() * 1000` hanya memberi ~10 bit entropi dan
 *     mengorbankan monotonicity per-tab.
 *
 * Skema baru (packing bit dalam 53-bit JS-safe):
 *   [ 32-bit epoch-detik | 12-bit per-tab counter | 9-bit boot-random ]
 *   - epoch-detik (bukan ms): 2^32 detik ≈ tahun 2106 → 80 tahun headroom,
 *     jauh melampaui umur format pesan mana pun.
 *   - per-tab counter 12-bit (reset per detik): 4096 pesan/detik/tab —
 *     mustahil terlampaui oleh UI chat (2.7 msg/ms); monotonic dalam satu tab.
 *   - boot-random 9-bit (512 slot): disekali per muat halaman — dua tab yang
 *     bangun di detik yang sama hanya bertabrakan bila 9-bit acak mereka sama
 *     (1/512) DAN counter mereka bertepatan di detik yang sama (praktis nol,
 *     dan tetap tidak fatal karena counter melompat acak per tab).
 *
 * CATATAN MONOTONICITY: karena counter dimulai dari titik acak di setiap detik
 * baru, id TIDAK monotonik sempurna antar-detik (bisa turun <4096). Monotonic
 * dalam satu detik dan ketiadaan duplikat adalah invarian yang penting untuk
 * dedupe server — urutan id tidak dipakai untuk sorting di mana pun.
 */

const TEMP_ID_EPOCH_BITS = 32; // detik sejak Unix epoch
const TEMP_ID_COUNTER_BITS = 12; // 4096 pesan per detik per tab
const TEMP_ID_RANDOM_BITS = 9; // 512 slot per detik antar-tab

const TEMP_ID_COUNTER_MASK = (1 << TEMP_ID_COUNTER_BITS) - 1;
const TEMP_ID_RANDOM_MASK = (1 << TEMP_ID_RANDOM_BITS) - 1;

// Sekali per muat halaman (per tab/worker context). crypto.getRandomValues
// dipakai bila tersedia — jauh lebih acak daripada Math.random.
let bootRandom = 0;
try {
  const buf = new Uint16Array(1);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
    bootRandom = buf[0]! & TEMP_ID_RANDOM_MASK;
  } else {
    bootRandom = Math.floor(Math.random() * (TEMP_ID_RANDOM_MASK + 1));
  }
} catch {
  bootRandom = Math.floor(Math.random() * (TEMP_ID_RANDOM_MASK + 1));
}

let counter = 0;
let counterSecond = 0;

export const generateTempId = (): number => {
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Counter monotonic dalam satu detik; lompat acak (bukan reset ke 0) saat
  // detik berganti agar pesan terakhir detik sebelumnya tidak menempel di
  // posisi rendah tab lain yang kebetulan satu slot acak.
  if (counterSecond === nowSeconds) {
    counter = (counter + 1) & TEMP_ID_COUNTER_MASK;
  } else {
    counterSecond = nowSeconds;
    counter = Math.floor(Math.random() * TEMP_ID_COUNTER_MASK); // 0..1023, hindari tepat maksimum
  }

  // 53-bit total: 32 (detik) + 10 (counter) + 11 (random) = 53. Aman.
  return (
    (nowSeconds * (1 << (TEMP_ID_COUNTER_BITS + TEMP_ID_RANDOM_BITS))) +
    (counter << TEMP_ID_RANDOM_BITS) +
    bootRandom
  );
};

/** Ekspos untuk pengujian & diagnosa (bukan bagian kontrak publik). */
export const __tempIdInternals = {
  get bootRandom() {
    return bootRandom;
  },
  MAX_SAFE_TEMP_ID: 2 ** 53 - 1,
};
