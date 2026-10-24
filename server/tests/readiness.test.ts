import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkReadiness } from '../src/utils/readiness.js';

const ok = async () => 'pong';
const boom = async () => { throw new Error('down'); };
const hang = () => new Promise<never>(() => {});

describe('checkReadiness', () => {
  it('semua check sukses → ok', async () => {
    const r = await checkReadiness([{ name: 'redis', run: ok }, { name: 'postgres', run: ok }]);
    assert.deepEqual(r, { ok: true, failed: [] });
  });

  it('satu check melempar → ok=false dan namanya tercatat', async () => {
    const r = await checkReadiness([{ name: 'redis', run: boom }, { name: 'postgres', run: ok }]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, ['redis']);
  });

  it('check yang menggantung dipotong timeout (tidak ikut menggantung)', async () => {
    const t0 = Date.now();
    const r = await checkReadiness([{ name: 'postgres', run: hang }, { name: 'redis', run: ok }], 50);
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, ['postgres']);
    assert.ok(Date.now() - t0 < 1000, 'harus selesai mendekati timeout, bukan menggantung');
  });

  it('semua gagal → daftar terurut; throw sinkron juga tertangkap', async () => {
    const r = await checkReadiness([
      { name: 'redis', run: () => { throw new Error('sync'); } },
      { name: 'postgres', run: boom },
    ]);
    assert.deepEqual(r, { ok: false, failed: ['postgres', 'redis'] });
  });

  it('daftar kosong → ok', async () => {
    assert.deepEqual(await checkReadiness([]), { ok: true, failed: [] });
  });
});
