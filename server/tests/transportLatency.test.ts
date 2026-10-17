// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

// [docs/10 §10.12] Uji pengukuran latensi ingress jalur WSS
// (`server/src/utils/transportLatency.ts`).
//
// Kenapa diuji tanpa soket: gateway socket.io tidak dijalankan di unit test
// (butuh server HTTP + klien sungguhan), sementara aturan alert
// `NyxTransportIngressSlow`/`NyxTransportSlowerThanWss` bertumpu pada angka yang
// dihasilkan modul itu. Yang diuji di sini justru bagian yang bisa salah dan
// tidak terlihat dari luar: berapa observasi yang tercatat per pengerjaan, apakah
// jalur error ikut tercatat, dan apakah satuannya DETIK (bukan milidetik —
// perbedaan itu tidak memicu error apa pun, hanya angka yang salah).

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMetricsText, resetMetricsForTests } from '../src/utils/metrics.js';
import { measureWssIngress } from '../src/utils/transportLatency.js';

/** Nilai satu sampel dari eksposisi teks (`null` bila serinya tidak ada). */
const sample = (name: string): number | null => {
  const line = renderMetricsText()
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name} `));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : null;
};

/** Jumlah observasi yang masuk satu bucket `le` (kumulatif). */
const bucket = (bound: string): number | null => {
  const line = renderMetricsText()
    .split('\n')
    .find((candidate) => candidate.startsWith(`nyx_wss_ingress_seconds_bucket{le="${bound}"} `));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : null;
};

test('histogram ingress WSS tanpa observasi dirender sebagai 0, bukan hilang', () => {
  resetMetricsForTests();
  const text = renderMetricsText();
  // Bukan "No data" di dashboard: deretnya ada dan bernilai 0.
  assert.match(text, /^nyx_wss_ingress_seconds_bucket\{le="0\.001"\} 0$/m);
  assert.match(text, /^nyx_wss_ingress_seconds_bucket\{le="\+Inf"\} 0$/m);
  assert.match(text, /^nyx_wss_ingress_seconds_sum 0$/m);
  assert.match(text, /^nyx_wss_ingress_seconds_count 0$/m);
});

test('pengerjaan yang berhasil mencatat tepat satu observasi', async () => {
  resetMetricsForTests();
  const result = await measureWssIngress(async () => 'nilai');
  assert.equal(result, 'nilai');
  assert.equal(sample('nyx_wss_ingress_seconds_count'), 1);
  assert.equal(bucket('+Inf'), 1);
  assert.ok((sample('nyx_wss_ingress_seconds_sum') ?? -1) >= 0);
});

test('pengerjaan yang melempar TIDAK dicatat, dan error diteruskan apa adanya', async () => {
  resetMetricsForTests();
  const boom = new Error('gagal di tengah');
  await assert.rejects(
    measureWssIngress(async () => {
      throw boom;
    }),
    (error: unknown) => error === boom
  );
  // Handler yang melempar berarti koneksinya direset gateway — itu kegagalan,
  // bukan "ingress lambat", dan durasinya tidak boleh menggeser p95.
  assert.equal(sample('nyx_wss_ingress_seconds_count'), 0);
  assert.equal(bucket('+Inf'), 0);
});

test('satuannya detik: pengerjaan 30 ms tidak jatuh di luar semua bucket', async () => {
  resetMetricsForTests();
  await measureWssIngress(() => new Promise((resolve) => setTimeout(resolve, 30)));

  // Pemeriksaan ini sengaja TIDAK menuntut bucket yang tepat: `setTimeout(30)`
  // bisa melar jauh saat seluruh suite berjalan (event loop sibuk), dan uji yang
  // menuntut "jatuh tepat di 0,05 s" akan gagal karena beban mesin — bukan karena
  // kodenya salah. Yang tetap benar tanpa bergantung waktu:
  //
  //   - nilainya di ATAS 0,025 s (timer 30 ms tidak pernah selesai lebih cepat), dan
  //   - nilainya di DALAM rentang bucket berhingga (<= 2,5 s).
  //
  // Pemeriksaan kedua itulah yang menangkap kesalahan satuan: kalau durasinya
  // dicatat dalam milidetik, 30 > 2,5 → hanya `+Inf` yang terisi dan
  // `bucket('2.5')` bernilai 0.
  assert.equal(bucket('0.025'), 0, 'tidak boleh tercatat di bawah 25 ms');
  assert.equal(bucket('2.5'), 1, 'durasi harus di dalam rentang bucket detik');
  assert.equal(bucket('+Inf'), 1);

  const sum = sample('nyx_wss_ingress_seconds_sum') ?? -1;
  assert.ok(sum >= 0.02 && sum < 2.5, `sum di luar rentang wajar: ${sum}`);
});
