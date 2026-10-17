// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Test perilaku `jobs/ktSnapshot.ts` — kebijakan unggah arsip log KT tanpa
 * jaringan/R2.
 *
 * Yang dijaga: manifest tidak sah **tidak** membaca berkas apa pun (nama berkas
 * berasal dari manifest → jalur `../` harus tertutup), unggahan idempoten,
 * retensi memakai umur objek (atau stempel nama bila tidak ada), dan kegagalan
 * dijawab sebagai laporan — bukan lemparan yang mematikan cron.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KT_SNAPSHOT_KEEP_DAYS,
  expiredKtSnapshotKeys,
  newestKtSnapshotRemoteSeconds,
  parseKtSnapshotManifest,
  uploadLatestKtSnapshot,
  type KtSnapshotManifest,
} from '../src/jobs/ktSnapshot.js';
import { renderMetricsText, resetMetricsForTests } from '../src/utils/metrics.js';

/**
 * Baca satu nilai dari eksposisi teks (0 bila serinya belum ada).
 *
 * Dipakai test kesegaran di bawah: yang dijaga bukan "kode memanggil setGauge"
 * melainkan "metrik yang dibaca alert berisi angka yang benar" — termasuk saat
 * unggahan dilewati dan saat daftar R2 gagal dibaca.
 */
const metricValue = (name: string, labels: Record<string, string> = {}): number => {
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  const line = renderMetricsText()
    .split('\n')
    .find((l) => l.startsWith(name) && wanted.every((pair) => l.includes(pair)));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
};

const FILE = 'kt-snapshot-20261014T030000Z.tar.gz';
const MANIFEST: KtSnapshotManifest = {
  file: FILE,
  createdAt: '2026-10-14T03:00:00Z',
  treeSize: 42,
  root: 'ab'.repeat(32),
  bytes: 1234,
};

interface Harness {
  put: Array<{ key: string; body: Uint8Array }>;
  deleted: string[][];
  readPaths: string[];
}

function harness(overrides: {
  manifestText?: string;
  remote?: Array<{ key: string; lastModified?: Date }>;
  failPut?: boolean;
  failList?: boolean;
  dir?: string;
} = {}): { state: Harness; deps: NonNullable<Parameters<typeof uploadLatestKtSnapshot>[0]> } {
  const state: Harness = { put: [], deleted: [], readPaths: [] };
  return {
    state,
    deps: {
      dir: overrides.dir ?? '/var/lib/nyx/kt-snapshots',
      readTextFile: async (path: string) => {
        state.readPaths.push(path);
        return overrides.manifestText ?? JSON.stringify(MANIFEST);
      },
      readBinaryFile: async (path: string) => {
        state.readPaths.push(path);
        return new Uint8Array([1, 2, 3]);
      },
      putObject: async (key: string, body: Uint8Array) => {
        if (overrides.failPut) throw new Error('R2 menolak');
        state.put.push({ key, body });
      },
      listObjects: async () => {
        if (overrides.failList) throw new Error('R2 tidak bisa dibaca');
        return overrides.remote ?? [];
      },
      deleteObjects: async (keys: string[]) => {
        state.deleted.push(keys);
      },
      now: () => new Date('2026-10-14T04:00:00Z'),
      log: () => {},
    },
  };
}

test('tanpa KT_SNAPSHOT_DIR: dilewati tanpa menyentuh berkas/objek', async () => {
  const { state, deps } = harness();
  // Jalur "fitur nonaktif": direktori tidak diatur → tidak ada I/O sama sekali.
  //
  // `process.env.KT_SNAPSHOT_DIR` dibersihkan selama test: implementasinya sengaja
  // jatuh ke env bila `deps.dir` tidak diberikan, jadi mesin yang `.env`-nya
  // terisi (self-host dengan snapshot KT aktif) dulu selalu melihat test ini
  // merah — kegagalan lingkungan, bukan perilaku produk.
  const prev = process.env.KT_SNAPSHOT_DIR;
  delete process.env.KT_SNAPSHOT_DIR;
  try {
    const outcome = await uploadLatestKtSnapshot({ ...deps, dir: undefined });
    assert.equal(outcome.skipped, 'disabled');
    assert.equal(outcome.uploaded, null);
  } finally {
    if (prev !== undefined) process.env.KT_SNAPSHOT_DIR = prev;
  }
  assert.deepEqual(state.put, []);
  assert.deepEqual(state.readPaths, []);
});

test('manifest tidak sah: tidak ada berkas yang dibaca dan tidak ada unggahan', async () => {
  for (const text of ['', 'bukan json', JSON.stringify({ ...MANIFEST, file: '../rahasia.tar.gz' }), JSON.stringify({ ...MANIFEST, root: 'zz'.repeat(32) }), JSON.stringify({ ...MANIFEST, treeSize: 0 })]) {
    const { state, deps } = harness({ manifestText: text });
    const outcome = await uploadLatestKtSnapshot(deps);
    assert.equal(outcome.skipped, 'manifest-invalid');
    // Hanya latest.json yang dibaca — tidak satu pun berkas arsip.
    assert.deepEqual(state.readPaths, ['/var/lib/nyx/kt-snapshots/latest.json']);
    assert.deepEqual(state.put, []);
  }
});

test('arsip baru diunggah dengan kunci prefix dan isi berkas apa adanya', async () => {
  const { state, deps } = harness();
  const outcome = await uploadLatestKtSnapshot(deps);
  assert.equal(outcome.uploaded, `kt-snapshots/${FILE}`);
  assert.deepEqual(state.put, [{ key: `kt-snapshots/${FILE}`, body: new Uint8Array([1, 2, 3]) }]);
  assert.deepEqual(outcome.errors, []);
});

test('idempoten: arsip yang sudah ada di R2 tidak diunggah ulang', async () => {
  const { state, deps } = harness({
    remote: [{ key: `kt-snapshots/${FILE}`, lastModified: new Date('2026-10-14T03:05:00Z') }],
  });
  const outcome = await uploadLatestKtSnapshot(deps);
  assert.equal(outcome.skipped, 'already-uploaded');
  assert.deepEqual(state.put, []);
  // Objek yang baru (masih segar) juga tidak dihapus.
  assert.deepEqual(state.deleted, []);
});

test('retensi: objek lebih tua dari batas dihapus, yang baru dipertahankan', async () => {
  const { state, deps } = harness({
    remote: [
      { key: 'kt-snapshots/kt-snapshot-20260101T030000Z.tar.gz', lastModified: new Date('2026-01-01T03:00:00Z') },
      { key: 'kt-snapshots/kt-snapshot-20261010T030000Z.tar.gz', lastModified: new Date('2026-10-10T03:00:00Z') },
    ],
  });
  const outcome = await uploadLatestKtSnapshot(deps);
  assert.deepEqual(state.deleted, [['kt-snapshots/kt-snapshot-20260101T030000Z.tar.gz']]);
  assert.equal(outcome.deleted, 1);
});

test('kegagalan unggah dilaporkan, tidak dilempar', async () => {
  const { state, deps } = harness({ failPut: true });
  const outcome = await uploadLatestKtSnapshot(deps);
  assert.equal(outcome.uploaded, null);
  assert.deepEqual(outcome.errors, ['R2 menolak']);
  assert.deepEqual(state.put, []);
});

test('expiredKtSnapshotKeys: umur dari lastModified, fallback stempel nama', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  const expired = expiredKtSnapshotKeys(
    [
      { key: 'kt-snapshots/kt-snapshot-20260901T000000Z.tar.gz' }, // dari stempel nama
      { key: 'kt-snapshots/kt-snapshot-20261013T000000Z.tar.gz' }, // baru
      { key: 'kt-snapshots/tanpa-stempel.tar.gz' }, // tidak diketahui → jangan dihapus
      // lastModified menang atas nama: objek tua yang baru diubah tidak dihapus.
      { key: 'kt-snapshots/kt-snapshot-20260902T000000Z.tar.gz', lastModified: new Date('2026-10-13T23:00:00Z') },
    ],
    now,
    KT_SNAPSHOT_KEEP_DAYS
  );
  assert.deepEqual(expired, ['kt-snapshots/kt-snapshot-20260901T000000Z.tar.gz']);
});

// ============================================================================
// [drill 2026-10-16] Kesegaran salinan di luar VPS
//
// Alert `NyxKtSnapshotNotUploaded` sekarang membaca
// `nyx_kt_snapshot_remote_latest_timestamp_seconds`, bukan lagi
// `increase(nyx_kt_snapshot_upload_total{result="ok"}[36h]) == 0` — pola lama itu
// menyala palsu setelah restart nyx-api (label-child prom-client hilang) dan pada
// hari yang dilewati karena arsipnya sudah ada di R2. Test di bawah mengunci tiga
// keadaan yang dulu salah dibaca.
// ============================================================================

test('newestKtSnapshotRemoteSeconds: lastModified menang, stempel nama jadi cadangan', () => {
  assert.equal(newestKtSnapshotRemoteSeconds([]), null);
  assert.equal(
    newestKtSnapshotRemoteSeconds([
      { key: 'kt-snapshots/kt-snapshot-20261001T000000Z.tar.gz' },
      { key: 'kt-snapshots/kt-snapshot-20261002T000000Z.tar.gz' },
      { key: 'kt-snapshots/tanpa-stempel.tar.gz' },
      { key: 'kt-snapshots/kt-snapshot-20260601T000000Z.tar.gz', lastModified: new Date('2026-10-14T03:05:00Z') },
    ]),
    Math.floor(Date.parse('2026-10-14T03:05:00Z') / 1000)
  );
  // Stempel yang tidak bisa dibaca bukan bukti kesegaran: dilewati, bukan 0.
  assert.equal(newestKtSnapshotRemoteSeconds([{ key: 'kt-snapshots/tanpa-stempel.tar.gz' }]), null);
});

test('kesegaran di R2 tetap termutakhir walau unggahan hari ini DILEWATI (idempoten)', async () => {
  resetMetricsForTests();
  const { deps } = harness({
    remote: [{ key: `kt-snapshots/${FILE}`, lastModified: new Date('2026-10-14T03:05:00Z') }],
  });
  const outcome = await uploadLatestKtSnapshot(deps);

  assert.equal(outcome.skipped, 'already-uploaded');
  // Inilah yang dulu tidak terjadi: jalur dilewati kini terlihat dan kesegaran
  // tetap dibaca dari isi R2, bukan dari memori proses.
  assert.equal(metricValue('nyx_kt_snapshot_upload_total', { result: 'skipped' }), 1);
  assert.equal(metricValue('nyx_kt_snapshot_upload_total', { result: 'ok' }), 0);
  assert.equal(
    metricValue('nyx_kt_snapshot_remote_latest_timestamp_seconds'),
    Math.floor(Date.parse('2026-10-14T03:05:00Z') / 1000)
  );
});

test('kesegaran di R2 memakai waktu unggah saat arsip BARU benar-benar diunggah', async () => {
  resetMetricsForTests();
  const { state, deps } = harness();
  await uploadLatestKtSnapshot(deps);

  assert.equal(state.put.length, 1);
  assert.equal(metricValue('nyx_kt_snapshot_upload_total', { result: 'ok' }), 1);
  assert.equal(
    metricValue('nyx_kt_snapshot_remote_latest_timestamp_seconds'),
    Math.floor(Date.parse('2026-10-14T04:00:00Z') / 1000)
  );
});

test('daftar R2 gagal dibaca + unggahan gagal: TIDAK ada klaim kesegaran', async () => {
  resetMetricsForTests();
  const { deps } = harness({ failList: true, failPut: true });
  const outcome = await uploadLatestKtSnapshot(deps);

  assert.equal(outcome.uploaded, null);
  assert.equal(outcome.errors.length, 2);
  // Vektor kosong = alert menyala setelah 36 jam (`absent_over_time`), bukan
  // langsung. Mengarang nilai 0 akan membuat `time() - max(...)` meledak
  // menjadi ~1,7 miliar detik dan alarm menyala seketika — persis pola yang
  // sedang dihapus dari aturan ini.
  assert.equal(metricValue('nyx_kt_snapshot_remote_latest_timestamp_seconds'), 0);
  const gaugeSamples = renderMetricsText()
    .split('\n')
    .filter((line) => line.startsWith('nyx_kt_snapshot_remote_latest_timestamp_seconds '));
  assert.deepEqual(gaugeSamples, [], 'kesegaran tidak diketahui → tidak ada sampel yang diklaim');
});

test('parseKtSnapshotManifest menerima bentuk dari kt-query dan menolak sisanya', () => {
  const parsed = parseKtSnapshotManifest(JSON.stringify(MANIFEST));
  assert.deepEqual(parsed, MANIFEST);
  assert.equal(parseKtSnapshotManifest(JSON.stringify({ ...MANIFEST, file: '/etc/passwd' })), null);
  assert.equal(parseKtSnapshotManifest(JSON.stringify({ ...MANIFEST, file: 'kt-snapshot-2026.tar.gz' })), null);
  assert.equal(parseKtSnapshotManifest('[]'), null);
});
