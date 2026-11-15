/**
 * [docs/39 §39.5] Jembatan anchor KT v2 antara backup dan restore.
 *
 * Kenapa statis: `backup.sh`/`restore.sh` butuh `age`, `pg_dump`/`pg_restore`,
 * dan host Postgres sungguhan — tidak ada jalur menjalankannya di CI unit test.
 * Yang bisa (dan harus) dijaga otomatis adalah **kontraknya**: backup WAJIB
 * mencatat `ktV2TreeSize`/`ktV2Root` dari `/head`, restore WAJIB membacanya,
 * meneruskannya sebagai `-expect-size`/`-expect-root`, dan WAJIB memberi
 * peringatan bila bundle lama tidak memuatnya. Tanpa penjaga ini, satu edit
 * yang menghapus dua baris meta mengembalikan drill ke `exit 0` yang buta
 * terhadap tree yang lebih kecil (§39.5d temuan 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BACKUP = path.join(ROOT, 'deploy/selfhost/scripts/backup.sh');
const RESTORE = path.join(ROOT, 'deploy/selfhost/scripts/restore.sh');

const backupScript = readFileSync(BACKUP, 'utf8');
const restoreScript = readFileSync(RESTORE, 'utf8');

function bashSyntaxOk(file: string): boolean | null {
  const probe = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  // Host tanpa bash (mis. Windows tanpa Git Bash) → test dilewati dengan alasan.
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  assert.equal(probe.status, 0, `bash -n ${file} gagal: ${probe.stderr}`);
  return true;
}

test('backup.sh mencatat anchor tree size + root log KT v2 ke meta bundle', () => {
  // Dibaca dari endpoint /head milik layanan baca KT v2 (port loopback).
  assert.match(backupScript, /\/head/, 'backup.sh harus membaca /head');
  assert.match(backupScript, /"treeSize"/, 'backup.sh harus mengekstrak treeSize');
  assert.match(backupScript, /"root"/, 'backup.sh harus mengekstrak root');
  assert.match(backupScript, /echo "ktV2TreeSize=\$kt_v2_tree_size"/, 'meta harus memuat ktV2TreeSize');
  assert.match(backupScript, /echo "ktV2Root=\$kt_v2_root"/, 'meta harus memuat ktV2Root');
  // Kegagalan membaca head tidak boleh menggagalkan backup, tetapi harus terlihat.
  assert.match(backupScript, /ktV2HeadUnavailable=1/);
  assert.match(backupScript, /PERINGATAN: head log KT v2 tidak terbaca/);
});

test('restore.sh membaca anchor, meneruskannya ke verifier, dan memperingatkan bundle lama', () => {
  assert.match(restoreScript, /sed -n 's\/\^ktV2TreeSize=\/\/p'/, 'restore harus membaca ktV2TreeSize');
  assert.match(restoreScript, /sed -n 's\/\^ktV2Root=\/\/p'/, 'restore harus membaca ktV2Root');

  // Peringatan eksplisit (bukan gagal diam-diam) untuk bundle tanpa anchor.
  assert.match(restoreScript, /PERINGATAN: bundle ini TIDAK memuat anchor log KT v2/);
  // Perbandingan memakai flag yang sama dengan drill/verifier.
  assert.match(restoreScript, /-expect-size/);
  assert.match(restoreScript, /-expect-root/);
  // Mismatch = exit non-zero, bukan "restore selesai" palsu.
  const mismatchBlock = restoreScript.slice(restoreScript.indexOf('if ! kt_anchor_check'));
  assert.match(mismatchBlock, /exit 1/, 'mismatch anchor harus menghentikan restore');
  assert.doesNotMatch(
    mismatchBlock.slice(0, mismatchBlock.indexOf('exit 1')),
    /echo "restore selesai"/,
    'pesan sukses tidak boleh dicetak sebelum anchor cocok'
  );
});

test('kedua skrip self-host lolos pemeriksaan sintaks bash', () => {
  const backup = bashSyntaxOk(BACKUP);
  const restore = bashSyntaxOk(RESTORE);
  if (backup === null || restore === null) {
    // Tidak ada bash: tidak ada yang bisa diklaim.
    return;
  }
  assert.equal(backup, true);
  assert.equal(restore, true);
});
