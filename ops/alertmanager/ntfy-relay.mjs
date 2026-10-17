#!/usr/bin/env node
// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/10 §10.12 · §10.16] Jembatan Alertmanager → ntfy.
 *
 * Kenapa ada berkas ini: Alertmanager **tidak punya receiver ntfy native**
 * (diperiksa dengan `amtool check-config` pada 0.34.1: `field ntfy_configs not
 * found in type config.plain`). Yang tersedia hanya receiver generik
 * (`webhook_configs`), dan payload-nya (JSON `{version,status,alerts:[]}`) bukan
 * bentuk yang bisa dibaca ntfy sebagai pesan. Jadi satu-satunya cara tanpa
 * menambah biner pihak ketiga adalah menerjemahkan payload itu sendiri.
 *
 * Pilihan bentuk jembatan:
 *   - Proses kecil ini (Node, hanya modul bawaan) — dipilih.
 *   - Biner komunitas (`alertmanager-ntfy`, `ntfy-alertmanager`) — menambah
 *     unduhan + supply chain baru untuk ~100 baris logika.
 *
 * Sifat yang dijaga:
 *   - **Loopback saja.** Alamat non-loopback DITOLAK, bukan diperingatkan:
 *     endpoint ini menerjemahkan isi alert infrastruktur ke kanal keluar, dan
 *     satu salah tulis alamat cukup untuk membukanya ke jaringan.
 *   - **Satu alert = satu baris.** Alertmanager sudah melakukan grouping; relay
 *     tidak boleh mengirim satu notifikasi per alert tanpa batas (batas keras
 *     `MAX_ALERTS_PER_MESSAGE`, sisanya diringkas sebagai hitungan).
 *   - **Gagal = 502.** Alertmanager mencoba ulang pada respons non-2xx; menjawab
 *     200 saat publikasi gagal akan menghilangkan notifikasi secara senyap.
 *   - **Tidak ada rahasia di log.** Topik ntfy dan token tidak pernah dicetak.
 *
 * Pemakaian:
 *   NTFY_TOPIC=<topik> node ops/alertmanager/ntfy-relay.mjs
 *   NTFY_URL=https://ntfy.sh NTFY_TOPIC=<topik> LISTEN_ADDR=127.0.0.1:9095 ...
 *   node ops/alertmanager/ntfy-relay.mjs --self-test   # uji format tanpa jaringan
 *
 * Env: NTFY_URL (default https://ntfy.sh), NTFY_TOPIC (WAJIB), NTFY_TOKEN
 * (opsional, Bearer), LISTEN_ADDR (default 127.0.0.1:9095), NTFY_ICON (opsional).
 *
 * Catatan port: **9095, bukan 9094**. Alertmanager memakai 9094/tcp sebagai
 * listener gossip HA-nya — memakai port itu membuat Alertmanager gagal start
 * dengan `bind: address already in use` (kejadian nyata saat pemasangan
 * 2026-10-17, lihat README).
 */

import http from 'node:http';
import process from 'node:process';

/** Batas ukuran body: payload Alertmanager nyata berukuran kilobyte. */
const MAX_BODY_BYTES = 1024 * 1024;
/** ntfy menolak pesan > 4096 byte; sisakan ruang untuk judul + tag. */
const MAX_MESSAGE_CHARS = 3500;
/** Alert yang ditulis penuh per notifikasi; sisanya diringkas jadi hitungan. */
const MAX_ALERTS_PER_MESSAGE = 5;
/** Batas waktu publikasi ke ntfy; Alertmanager yang menangani percobaan ulang. */
const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Prioritas ntfy dari label `severity` Alertmanager (skala ntfy 1..5).
 * `resolved` selalu turun satu tingkat: kabar baik tidak boleh berkedip seperti
 * alarm — tapi tetap harus terlihat (kalau tidak, orang berhenti percaya pada
 * notifikasi "selesai" dan mulai mengecek UI secara manual).
 */
export function priorityFor(alert) {
  const firing = alert?.status === 'firing';
  const severity = alert?.labels?.severity ?? '';
  if (!firing) return 2;
  if (severity === 'critical') return 5;
  if (severity === 'high') return 4;
  return 3;
}

/** Tag ntfy (shortcode emoji di aplikasi) dari status + severity. */
export function tagsFor(alerts) {
  if (alerts.some((alert) => alert.status === 'firing' && alert.labels?.severity === 'critical')) {
    return ['rotating_light'];
  }
  if (alerts.some((alert) => alert.status === 'firing')) return ['warning'];
  return ['white_check_mark'];
}

function truncate(text, limit = MAX_MESSAGE_CHARS) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (dipotong: pesan Alertmanager lebih panjang dari ${limit} karakter)`;
}

/** Ringkasan satu alert: nama, severity, ringkasan, dan ringkasan label. */
function formatAlert(alert) {
  const name = alert?.labels?.alertname ?? 'Alert';
  const severity = alert?.labels?.severity ?? 'unknown';
  const summary = alert?.annotations?.summary ?? '(tanpa summary)';
  // Label enum NYX hanya menambah konteks (guard, job, mountpoint); label
  // identitas tidak pernah dipakai di metrik NYX (docs/30 §30.1 poin 4).
  const extra = Object.entries(alert?.labels ?? {})
    .filter(([key]) => !['alertname', 'severity'].includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return [`${alert?.status === 'firing' ? 'FIRING' : 'RESOLVED'}  ${name} (${severity})`, summary, extra ? `  ${extra}` : '']
    .filter(Boolean)
    .join('\n');
}

/**
 * Payload Alertmanager v4 → {title, message, priority, tags}. Murni dan
 * deterministik supaya bisa diuji tanpa jaringan (`--self-test`).
 */
export function buildNotification(payload) {
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  const firing = alerts.filter((alert) => alert?.status === 'firing');
  const resolved = alerts.length - firing.length;
  const names = [...new Set(alerts.map((alert) => alert?.labels?.alertname ?? 'Alert'))];

  const head = `${firing.length} firing${resolved > 0 ? ` · ${resolved} resolved` : ''}`;
  const title = `${head}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;

  const shown = alerts.slice(0, MAX_ALERTS_PER_MESSAGE);
  const rest = alerts.length - shown.length;
  const message = truncate([...shown.map(formatAlert), rest > 0 ? `… dan ${rest} alert lain (lihat UI Prometheus /alerts)` : '']
    .filter(Boolean)
    .join('\n\n'));

  return { title: truncate(title, 200), message, priority: Math.max(...alerts.map(priorityFor), 2), tags: tagsFor(alerts) };
}

/** Host loopback saja (127.0.0.0/8, ::1, localhost) — sama dengan aturan exporter. */
export function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(host);
}

function parseListenAddr(raw) {
  const match = /^(.+):(\d+)$/.exec(raw ?? '');
  if (!match) throw new Error(`LISTEN_ADDR tidak sah: ${raw}`);
  const host = match[1];
  if (!isLoopbackHost(host)) {
    throw new Error(`LISTEN_ADDR harus loopback (127.0.0.1/::1), bukan ${host} — relay ini mengirim isi alert ke luar`);
  }
  return { host, port: Number(match[2]) };
}

export function createPublish({ url, topic, token, icon, log }) {
  const endpoint = `${url.replace(/\/+$/, '')}/`;
  return async (notification) => {
    const body = { topic, title: notification.title, message: notification.message, priority: notification.priority, tags: notification.tags };
    if (icon) body.icon = icon;
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log(`ntfy menolak (HTTP ${response.status}): ${detail.slice(0, 300)}`);
      throw new Error(`ntfy HTTP ${response.status}`);
    }
    log(`terkirim: "${notification.title}" (priority ${notification.priority})`);
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body terlalu besar'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export function createServer({ publish, log }) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'text/plain' }).end('gunakan POST\n');
      return;
    }
    try {
      const raw = await readBody(request);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain' }).end('payload bukan JSON\n');
        return;
      }
      await publish(buildNotification(payload));
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    } catch (error) {
      // 502 supaya Alertmanager mencoba ulang; 413/400 adalah kesalahan pemanggil.
      const status = error?.statusCode ?? 502;
      log(`gagal meneruskan alert: ${error instanceof Error ? error.message : String(error)}`);
      response.writeHead(status, { 'content-type': 'text/plain' }).end('gagal\n');
    }
  });
}

/** Payload contoh untuk `--self-test` (bentuk Alertmanager v4, diringkas). */
const SELF_TEST_PAYLOAD = {
  version: '4',
  status: 'firing',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'NyxKtAuditorDown', severity: 'critical', job: 'nyx-kt-auditor' },
      annotations: { summary: 'Auditor log KT tidak bisa di-scrape (proses mati?)' },
    },
    {
      status: 'resolved',
      labels: { alertname: 'NyxKtSnapshotNotUploaded', severity: 'high', job: 'nyx-api' },
      annotations: { summary: 'Arsip snapshot log KT di R2 tidak lebih baru dari 36 jam' },
    },
  ],
};

function runSelfTest() {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${label}: dapat ${JSON.stringify(actual)}, ingin ${JSON.stringify(expected)}`);
    }
  };

  const notification = buildNotification(SELF_TEST_PAYLOAD);
  check('title menyebut jumlah firing/resolved', notification.title.startsWith('1 firing · 1 resolved:'), true);
  check('priority = tertinggi yang menyala', notification.priority, 5);
  check('tag = rotating_light untuk critical', notification.tags, ['rotating_light']);
  check('alert firing ditulis penuh', notification.message.includes('FIRING  NyxKtAuditorDown (critical)'), true);
  check('alert resolved ikut terlihat', notification.message.includes('RESOLVED  NyxKtSnapshotNotUploaded (high)'), true);
  check('label enum ikut sebagai konteks', notification.message.includes('job=nyx-kt-auditor'), true);
  check('pesan kosong tidak melempar', buildNotification({}).priority, 2);
  check('resolved saja tetap lower priority', priorityFor({ status: 'resolved', labels: { severity: 'critical' } }), 2);
  check('host non-loopback ditolak', isLoopbackHost('0.0.0.0'), false);
  check('127.0.0.1 diterima', isLoopbackHost('127.0.0.1'), true);

  // Ringkasan alert berlebih harus dipotong, bukan dikirim seluruhnya.
  const many = {
    alerts: Array.from({ length: 9 }, (_, index) => ({
      status: 'firing',
      labels: { alertname: `Alert${index}`, severity: 'high' },
      annotations: { summary: 'ringkasan' },
    })),
  };
  check('alert berlebih diringkas', buildNotification(many).message.includes('dan 4 alert lain'), true);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`❌ ${failure}`);
    return 1;
  }
  console.log('✅ relay ntfy: format notifikasi sesuai harapan');
  return 0;
}

function main() {
  const log = (message) => console.log(`[ntfy-relay] ${message}`);

  if (process.argv.includes('--self-test')) {
    process.exitCode = runSelfTest();
    return;
  }

  const topic = process.env.NTFY_TOPIC ?? '';
  if (!topic) {
    console.error('[ntfy-relay] NTFY_TOPIC kosong — tanpa topik, tidak ada yang bisa dikirimi. Berhenti (bukan jalan tanpa notifikasi).');
    process.exitCode = 2;
    return;
  }

  let address;
  try {
    address = parseListenAddr(process.env.LISTEN_ADDR ?? '127.0.0.1:9095');
  } catch (error) {
    console.error(`[ntfy-relay] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  const publish = createPublish({
    url: process.env.NTFY_URL ?? 'https://ntfy.sh',
    topic,
    token: process.env.NTFY_TOKEN ?? '',
    icon: process.env.NTFY_ICON ?? '',
    log,
  });

  const server = createServer({ publish, log });
  server.listen(address.port, address.host, () => {
    // Alamat + topik TIDAK dicetak apa adanya: topik adalah satu-satunya rahasia
    // kanal ini (siapa pun yang tahu nama topik bisa membaca notifikasi).
    log(`mendengarkan di http://${address.host}:${address.port} (topik: ${topic.length} karakter, disamarkan)`);
  });
  server.on('error', (error) => {
    console.error(`[ntfy-relay] server gagal: ${error.message}`);
    process.exitCode = 1;
  });
}

// Hanya jalankan server bila dieksekusi langsung (impor untuk test tidak memulai listener).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
