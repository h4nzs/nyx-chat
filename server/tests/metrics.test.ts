// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-G] Metrik tanpa telemetry — kontrak + penjaga privasi.
 *
 * Yang diuji:
 *   1. Format eksposisi Prometheus (HELP/TYPE/sample, histogram kumulatif).
 *   2. Penjaga identitas: nilai label yang berbentuk userId/usernameHash/token/
 *      IP/email DITOLAK dan justru tercatat di `nyx_metrics_rejected_total`
 *      (kebocoran ke metrik harus terlihat, bukan senyap).
 *   3. Kardinalitas terkendali: metrik/label tak terdeklarasi ditolak.
 *   4. Endpoint `/metrics`: hidup di host loopback, hanya path `/metrics`,
 *      tidak menahan proses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  defineCounter,
  defineGauge,
  defineHistogram,
  incCounter,
  setGauge,
  observeHistogram,
  renderMetricsText,
  resetMetricsForTests,
  nowSeconds,
  METRICS_REJECTED,
  RELAY_OPS,
  SWEEPER_DURATION,
  SWEEPER_LAST_RUN,
} from '../src/utils/metrics.js';
import {
  startMetricsServer,
  stopMetricsServer,
  metricsHost,
  metricsPortFor,
} from '../src/utils/metricsEndpoint.js';

const rejectedTotal = (text: string, reason: string): number => {
  const match = text.match(new RegExp(`nyx_metrics_rejected_total\\{reason="${reason}"\\} (\\d+)`));
  return match ? Number.parseInt(match[1]!, 10) : 0;
};

test('metrik: counter/gauge/histogram terekspos dengan format Prometheus', () => {
  resetMetricsForTests();
  const counter = defineCounter('nyx_test_events_total', 'Hanya untuk test', ['kind']);
  const gauge = defineGauge('nyx_test_queue_depth', 'Hanya untuk test');
  const hist = defineHistogram('nyx_test_latency_seconds', 'Hanya untuk test', [0.5, 1, 5], ['op']);

  incCounter(counter, { kind: 'a' });
  incCounter(counter, { kind: 'a' }, 4);
  incCounter(counter, { kind: 'b' });
  setGauge(gauge, 7);
  observeHistogram(hist, 0.2, { op: 'relay' });
  observeHistogram(hist, 3, { op: 'relay' });

  const text = renderMetricsText();
  assert.match(text, /# HELP nyx_test_events_total Hanya untuk test/);
  assert.match(text, /# TYPE nyx_test_events_total counter/);
  assert.match(text, /nyx_test_events_total\{kind="a"\} 5/);
  assert.match(text, /nyx_test_events_total\{kind="b"\} 1/);
  assert.match(text, /# TYPE nyx_test_queue_depth gauge/);
  assert.match(text, /nyx_test_queue_depth 7/);
  // Histogram: bucket kumulatif + `+Inf` = count, plus sum.
  // Observasi: 0.2s dan 3s → kumulatif: ≤0.5 = 1, ≤1 = 1, ≤5 = 2.
  assert.match(text, /nyx_test_latency_seconds_bucket\{le="0.5",op="relay"\} 1/);
  assert.match(text, /nyx_test_latency_seconds_bucket\{le="1",op="relay"\} 1/);
  assert.match(text, /nyx_test_latency_seconds_bucket\{le="5",op="relay"\} 2/);
  assert.match(text, /nyx_test_latency_seconds_bucket\{le="\+Inf",op="relay"\} 2/);
  assert.match(text, /nyx_test_latency_seconds_sum\{op="relay"\} 3\.2/);
  assert.match(text, /nyx_test_latency_seconds_count\{op="relay"\} 2/);
});

test('metrik: nilai label berbentuk identitas DITOLAK dan tercatat sebagai penolakan', () => {
  resetMetricsForTests();
  const before = rejectedTotal(renderMetricsText(), 'label_value');

  const forbiddenValues: Record<string, string> = {
    userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    usernameHash: 'a'.repeat(64),
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    ipv4: '203.0.113.7',
    ipv6: '2001:db8::1',
    email: 'han@nyx-app.my.id',
  };

  for (const value of Object.values(forbiddenValues)) {
    incCounter(RELAY_OPS, { op: value, result: 'accepted' });
  }

  const text = renderMetricsText();
  const after = rejectedTotal(text, 'label_value');
  assert.equal(after - before, Object.keys(forbiddenValues).length, 'setiap nilai identitas harus ditolak');

  // Tidak ada satu pun nilai terlarang yang bocor ke output.
  for (const value of Object.values(forbiddenValues)) {
    assert.ok(!text.includes(value), `nilai terlarang bocor ke /metrics: ${value}`);
  }
});

test('metrik: kardinalitas terkendali — label tak terdeklarasi & label kurang ditolak', () => {
  resetMetricsForTests();
  const before = rejectedTotal(renderMetricsText(), 'label_value');

  // `uid` tidak ada di deklarasi label RELAY_OPS (hanya op + result).
  incCounter(RELAY_OPS, { op: '0x1', result: 'accepted', uid: 'x' });
  // Label terdeklarasi kurang (`result` hilang) → deret waktu bercampur bentuk.
  incCounter(RELAY_OPS, { op: '0x1' });

  const text = renderMetricsText();
  assert.equal(rejectedTotal(text, 'label_value') - before, 2);
  assert.ok(!text.includes('uid='), 'label tak terdeklarasi tidak boleh muncul');
});

test('metrik: nilai label enum pendek tetap diterima (penjaga tidak over-blocking)', () => {
  resetMetricsForTests();
  const before = rejectedTotal(renderMetricsText(), 'label_value');
  incCounter(RELAY_OPS, { op: '0x1', result: 'accepted' });
  incCounter(RELAY_OPS, { op: '0xb', result: 'blocked' });
  const text = renderMetricsText();
  assert.equal(rejectedTotal(text, 'label_value'), before);
  assert.match(text, /nyx_relay_ops_total\{op="0x1",result="accepted"\} 1/);
  assert.match(text, /nyx_relay_ops_total\{op="0xb",result="blocked"\} 1/);
});

test('metrik: deklarasi ganda & nama tanpa prefix nyx_ ditolak saat definisi', () => {
  assert.throws(() => defineCounter('events_total', 'tanpa prefix', []), /nyx_/);
  assert.throws(() => defineCounter('nyx_test_events_total', 'duplikat', ['kind']), /sudah dideklarasikan/);
  assert.throws(() => defineHistogram('nyx_test_hist_no_buckets', 'tanpa buckets', []), /buckets/);
});

test('metrik: penulisan dengan tipe salah tercatat sebagai wrong_type, bukan crash', () => {
  resetMetricsForTests();
  const before = rejectedTotal(renderMetricsText(), 'wrong_type');
  // SWEEPER_DURATION adalah histogram → incCounter harus ditolak rapi.
  incCounter(SWEEPER_DURATION, { result: 'ok' });
  assert.equal(rejectedTotal(renderMetricsText(), 'wrong_type') - before, 1);
});

test('metrik: setGauge menimpa nilai (bukan menambah) dan timestamp masuk akal', () => {
  resetMetricsForTests();
  setGauge(SWEEPER_LAST_RUN, 1000, { result: 'ok' });
  setGauge(SWEEPER_LAST_RUN, 2000, { result: 'ok' });
  const text = renderMetricsText();
  assert.match(text, /nyx_sweeper_last_run_timestamp_seconds\{result="ok"\} 2000/);
  assert.ok(!text.includes(' 1000'));
  const now = nowSeconds();
  assert.ok(now > 1_700_000_000, 'timestamp unix detik (bukan milidetik)');
});

test('metrik: penolakan tidak menumbuhkan deret waktu tanpa batas (label reason tetap enum)', () => {
  resetMetricsForTests();
  for (let i = 0; i < 50; i++) {
    incCounter(RELAY_OPS, { op: `user-${i}-bahkan-ini-panjang`, result: 'accepted' });
  }
  const text = renderMetricsText();
  const rejectionSeries = text.match(/^nyx_metrics_rejected_total\{[^\n]*$/gm) ?? [];
  assert.equal(rejectionSeries.length, 1, 'hanya satu deret penolakan (reason=label_value)');
  assert.match(rejectionSeries[0]!, /reason="label_value"\} 50/);
  assert.equal(METRICS_REJECTED.name, 'nyx_metrics_rejected_total');
});

test('exporter: hidup di loopback, hanya melayani GET /metrics, dan bisa dimatikan', async () => {
  resetMetricsForTests();
  incCounter(RELAY_OPS, { op: '0x1', result: 'accepted' });

  process.env.METRICS_PORT = '19464';
  process.env.METRICS_HOST = '127.0.0.1';
  process.env.NODE_APP_INSTANCE = '0';
  const server = startMetricsServer();
  assert.ok(server, 'exporter harus jalan pada port uji');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));

  const host = metricsHost();
  assert.equal(host, '127.0.0.1', 'default host wajib loopback');

  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ host, port: 19464, path: '/metrics', method: 'GET' }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['content-type']), /text\/plain/);
        resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
  assert.match(body, /nyx_relay_ops_total\{op="0x1",result="accepted"\} 1/);

  const notFound = await new Promise<number>((resolve, reject) => {
    const req = request({ host, port: 19464, path: '/api/users', method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(notFound, 404, 'path selain /metrics tidak dilayani');

  stopMetricsServer();
  delete process.env.METRICS_PORT;
  delete process.env.METRICS_HOST;
  delete process.env.NODE_APP_INSTANCE;
});

test('exporter: port worker = METRICS_PORT + NODE_APP_INSTANCE', () => {
  assert.equal(metricsPortFor({ METRICS_PORT: '19464' }), 19464);
  assert.equal(metricsPortFor({ METRICS_PORT: '19464', NODE_APP_INSTANCE: '2' }), 19484);
  assert.equal(metricsPortFor({ METRICS_PORT: '19464', NODE_APP_INSTANCE: 'rusak' }), 19464);
  assert.equal(metricsPortFor({ METRICS_PORT: '0', NODE_APP_INSTANCE: '2' }), 0);
});

test('exporter: METRICS_PORT=0 mematikan endpoint secara eksplisit', () => {
  process.env.METRICS_PORT = '0';
  const server = startMetricsServer();
  assert.equal(server, null);
  delete process.env.METRICS_PORT;
});

test('metrics-targets: file_sd berisi satu port per worker; METRICS_PORT=0 kosong', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-metrics-'));
  const script = fileURLToPath(new URL('../../scripts/metrics-targets.mjs', import.meta.url));
  const out = join(dir, 'nyx-api.json');
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [script, ...args, '--out', out], { stdio: 'pipe' });

  try {
    run('--base', '19464', '--workers', '2');
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), [
      { targets: ['127.0.0.1:19464', '127.0.0.1:19474'] },
    ]);

    run('--base', '0', '--workers', '2');
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
