// Pakai: node ops/cloudflare/worker/build.mjs            (tanpa tautan status)
//        STATUS_URL="https://status.example" node ops/cloudflare/worker/build.mjs
// Menulis ops/cloudflare/worker/server-down-worker.js (hasil build, di-commit).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const statusUrl = process.env.STATUS_URL ?? '';
let html = readFileSync(new URL('./src/fallback.html', import.meta.url), 'utf8');
if (statusUrl) {
  if (!/^https:\/\//.test(statusUrl)) throw new Error('STATUS_URL harus diawali https://');
  html = html.replace('href="__STATUS_URL__"', `href="${statusUrl.replace(/"/g, '&quot;')}"`);
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const one = (tag) => {
  const found = [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
  if (!found.length) throw new Error(`<${tag}> tidak ditemukan`);
  return found[0][1];
};
const styleHash = sha(one('style'));
const scriptHash = sha(one('script'));

let tpl = readFileSync(new URL('./src/worker.template.js', import.meta.url), 'utf8');
tpl = tpl
  .replace('__HTML__', () => JSON.stringify(html))
  .replace('__STYLE_HASH__', styleHash)
  .replace('__SCRIPT_HASH__', scriptHash);

writeFileSync(new URL('./server-down-worker.js', import.meta.url), tpl);
console.log('OK server-down-worker.js |', Buffer.byteLength(tpl), 'bytes | style', styleHash.slice(0, 8), '| script', scriptHash.slice(0, 8));
