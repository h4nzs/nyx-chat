/**
 * NYX — "server down" Worker.  FILE HASIL BUILD — jangan edit langsung.
 * Sumber : ops/cloudflare/worker/src/{fallback.html,worker.template.js}
 * Build  : node ops/cloudflare/worker/build.mjs   (STATUS_URL=https://... opsional)
 *          — build ikut menghitung ulang hash CSP; mengedit HTML tanpa build = halaman rusak.
 * Deploy : manual — tempel isi file ini ke editor Worker `nyx-server-down` di dashboard
 *          Cloudflare. Route: app.nyx-app.my.id/* dan nyx-app.my.id/*.
 *
 * Meneruskan semua request ke origin; hanya bila origin tidak terjangkau
 * (fetch gagal / 502,503,504 / 520-530) ia mengganti respons:
 *   - navigasi HTML  -> halaman fallback (503, no-store, Retry-After)
 *   - lainnya (API)  -> JSON 503 {"error":"server_unreachable"} supaya klien bisa mendeteksi
 */
const FALLBACK_HTML = __HTML__;

const CSP = "default-src 'none'; style-src 'sha256-__STYLE_HASH__'; script-src 'sha256-__SCRIPT_HASH__'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const isCfOriginError = (s) => s >= 520 && s <= 530;
const isGatewayError = (s) => s === 502 || s === 503 || s === 504;

function isNavigation(request) {
  if (request.method !== 'GET') return false;
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document';
  return (request.headers.get('Accept') || '').includes('text/html');
}

function fallbackResponse() {
  return new Response(FALLBACK_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '30',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function jsonDown() {
  return new Response(JSON.stringify({ error: 'server_unreachable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': '30',
    },
  });
}

export default {
  async fetch(request) {
    let res;
    try {
      res = await fetch(request);
    } catch {
      return isNavigation(request) ? fallbackResponse() : jsonDown();
    }

    if (isCfOriginError(res.status)) {
      return isNavigation(request) ? fallbackResponse() : jsonDown();
    }
    // 502/503/504 dari nginx saat upstream (Node) mati: ganti hanya untuk navigasi.
    if (isGatewayError(res.status) && isNavigation(request)) {
      return fallbackResponse();
    }
    return res;
  },
};
