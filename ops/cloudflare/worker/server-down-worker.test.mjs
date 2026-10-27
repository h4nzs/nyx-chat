// Jalankan: node --test ops/cloudflare/worker/server-down-worker.test.mjs
// Tanpa dependensi, tanpa jaringan: fetch di-stub.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// File hasil build memakai `export default` tetapi berekstensi .js tanpa package
// "type: module" di sekitarnya — impor lewat data URL agar tidak bergantung pada itu.
const src = readFileSync(new URL('./server-down-worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;

const nav = () => new Request('https://app.nyx-app.my.id/chat', { headers: { 'Sec-Fetch-Dest': 'document' } });
const api = () => new Request('https://app.nyx-app.my.id/api/system/status', { headers: { 'Sec-Fetch-Dest': 'empty' } });

const realFetch = globalThis.fetch;
let origin;
beforeEach(() => { globalThis.fetch = async () => origin(); });
afterEach(() => { globalThis.fetch = realFetch; });

const run = async (req, o) => { origin = o; return worker.fetch(req); };
const ctype = (r) => r.headers.get('content-type') ?? '';

describe('server-down worker', () => {
  it('fetch gagal → navigasi: halaman 503; API: JSON 503', async () => {
    const boom = () => { throw new Error('unreachable'); };
    const n = await run(nav(), boom);
    assert.equal(n.status, 503); assert.match(ctype(n), /text\/html/);
    assert.equal(n.headers.get('cache-control'), 'no-store');
    const a = await run(api(), boom);
    assert.equal(a.status, 503); assert.deepEqual(await a.json(), { error: 'server_unreachable' });
  });

  it('520–530 (mis. 530 tunnel mati) diganti; 519/531 tidak', async () => {
    for (const s of [520, 522, 530]) {
      assert.equal((await run(nav(), () => new Response('cf', { status: s }))).status, 503, `status ${s}`);
    }
    for (const s of [519, 531]) {
      assert.equal((await run(nav(), () => new Response('x', { status: s }))).status, s, `status ${s}`);
    }
  });

  it('502/503/504 hanya diganti untuk navigasi; API diteruskan apa adanya', async () => {
    for (const s of [502, 503, 504]) {
      const n = await run(nav(), () => new Response('bad', { status: s }));
      assert.match(ctype(n), /text\/html/, `nav ${s}`);
      const a = await run(api(), () => new Response('bad', { status: s }));
      assert.equal(a.status, s); assert.equal(await a.text(), 'bad');
    }
  });

  it('respons sah dari app (200/404/429/500) diteruskan utuh', async () => {
    for (const s of [200, 404, 429, 500]) {
      const r = await run(nav(), () => new Response('app', { status: s }));
      assert.equal(r.status, s); assert.equal(await r.text(), 'app');
    }
  });

  it('non-GET tidak pernah dianggap navigasi', async () => {
    const post = new Request('https://app.nyx-app.my.id/x', { method: 'POST', body: 'a', headers: { 'Sec-Fetch-Dest': 'document' } });
    const r = await run(post, () => new Response('bad', { status: 502 }));
    assert.equal(r.status, 502);
  });

  it('fallback tanpa Sec-Fetch-Dest: jatuh ke header Accept', async () => {
    const req = new Request('https://app.nyx-app.my.id/', { headers: { Accept: 'text/html,application/xhtml+xml' } });
    assert.match(ctype(await run(req, () => new Response('', { status: 530 }))), /text\/html/);
  });
});

describe('halaman fallback', () => {
  let html, csp;
  beforeEach(async () => {
    const r = await run(nav(), () => { throw new Error('down'); });
    html = await r.text(); csp = r.headers.get('content-security-policy') ?? '';
  });

  it('hash CSP cocok dengan <style>/<script> inline (hash basi = halaman rusak)', () => {
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
    const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.ok(csp.includes(`style-src 'sha256-${sha(style)}'`), 'hash style tidak cocok — jalankan build.mjs');
    assert.ok(csp.includes(`script-src 'sha256-${sha(script)}'`), 'hash script tidak cocok — jalankan build.mjs');
  });

  it('tidak memuat sumber eksternal (janji privasi: tak ada IP bocor sebelum klik)', () => {
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /@import/i);
    assert.doesNotMatch(html, /\b(?:src|action)=["']?(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /url\(\s*["']?(?:https?:)?\/\//i);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
  });
});
