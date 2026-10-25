/**
 * NYX — "server down" Worker.
 * Dipasang pada route app.nyx-app.my.id/* (dan nyx-app.my.id/*).
 * Meneruskan semua request ke origin; hanya bila origin tidak terjangkau
 * (fetch gagal / 502,503,504 / 520-530) ia mengganti respons:
 *   - navigasi HTML  -> halaman fallback (503, no-store, Retry-After)
 *   - lainnya (API)  -> JSON 503 {"error":"server_unreachable"} supaya klien bisa mendeteksi
 * Dibuat oleh build.mjs — JANGAN edit dist/worker.js langsung.
 * Update code ini jika diperlukan dan atau perintah eksplisit, perubahannya manual melalui dashboard cloudflare.
 */
const FALLBACK_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n<meta name=\"color-scheme\" content=\"dark light\">\n<title>NYX</title>\n<style>\n:root{--bg:0 0% 10%;--surface:0 0% 13%;--text:210 40% 98%;--muted:215 20% 70%;--accent:217 91% 60%;\n--sd:0 0% 6%;--sl:0 0% 18%}\n@media (prefers-color-scheme:light){:root{--bg:220 16% 90%;--surface:220 16% 90%;--text:222 47% 11%;--muted:215 25% 45%;\n--sd:220 14% 78%;--sl:0 0% 100%}}\n*{box-sizing:border-box}\nhtml,body{height:100%;margin:0}\nbody{display:flex;align-items:center;justify-content:center;padding:16px;background:hsl(var(--bg));color:hsl(var(--text));\nfont-family:Inter,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}\n.glow{position:fixed;top:50%;left:50%;width:384px;height:384px;transform:translate(-50%,-50%);border-radius:50%;\nbackground:hsl(var(--accent)/.1);filter:blur(100px);pointer-events:none}\n.card{position:relative;z-index:1;max-width:28rem;width:100%;padding:2rem;border-radius:1.5rem;text-align:center;\nbackground:hsl(var(--surface));border:1px solid hsl(var(--muted)/.1);\nbox-shadow:6px 6px 12px hsl(var(--sd)),-6px -6px 12px hsl(var(--sl))}\n.icon{width:5rem;height:5rem;margin:0 auto 1.5rem;border-radius:50%;display:flex;align-items:center;justify-content:center;\nbackground:hsl(var(--bg));box-shadow:inset 6px 6px 10px hsl(var(--sd)),inset -6px -6px 10px hsl(var(--sl))}\n.icon svg{width:2rem;height:2rem;stroke:hsl(var(--accent));animation:pulse 2s ease-in-out infinite}\n@keyframes pulse{50%{opacity:.4}}\nh1{font-size:1.5rem;font-weight:700;margin:0 0 .5rem}\np{font-size:.875rem;line-height:1.65;color:hsl(var(--muted));margin:0 0 1.5rem}\nbutton{width:100%;padding:.75rem 1rem;border:0;border-radius:.75rem;font:inherit;font-weight:600;cursor:pointer;\ncolor:hsl(var(--accent));background:hsl(var(--surface));box-shadow:6px 6px 12px hsl(var(--sd)),-6px -6px 12px hsl(var(--sl))}\nbutton:active{box-shadow:inset 6px 6px 10px hsl(var(--sd)),inset -6px -6px 10px hsl(var(--sl))}\nbutton:focus-visible,a:focus-visible{outline:2px solid hsl(var(--accent));outline-offset:3px}\n.meta{margin-top:1.25rem;font-size:.75rem;color:hsl(var(--muted))}\n.meta a{color:hsl(var(--accent));text-decoration:none}\n.meta a:hover{text-decoration:underline}\n#statusRow[hidden]{display:none}\n@media (prefers-reduced-motion:reduce){.icon svg{animation:none}}\n</style>\n</head>\n<body>\n<div class=\"glow\"></div>\n<main class=\"card\" role=\"alert\" aria-live=\"polite\">\n  <div class=\"icon\" aria-hidden=\"true\">\n    <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\">\n      <path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z\"/><path d=\"M12 8v4\"/><path d=\"M12 16h.01\"/>\n    </svg>\n  </div>\n  <h1 id=\"t\"></h1>\n  <p id=\"d\"></p>\n  <button id=\"b\" type=\"button\"></button>\n  <div class=\"meta\"><span id=\"n\"></span><span id=\"statusRow\" hidden> · <a id=\"s\" href=\"__STATUS_URL__\" rel=\"noopener noreferrer\"></a></span></div>\n</main>\n<noscript><style>#b{display:none}</style></noscript>\n<script>\n(function(){\nvar L={\nen:{t:\"NYX is temporarily unreachable\",d:\"We can't reach our servers right now. Your data stays encrypted on your device. This page reloads automatically as soon as we're back.\",b:\"Try again\",n:\"Next check in {n}s\",c:\"Checking…\",s:\"Status & updates\"},\nid:{t:\"NYX sedang tidak dapat dijangkau\",d:\"Kami tidak dapat menjangkau server saat ini. Data Anda tetap terenkripsi di perangkat Anda. Halaman ini memuat ulang otomatis begitu kami kembali.\",b:\"Coba lagi\",n:\"Pengecekan berikutnya {n} dtk\",c:\"Memeriksa…\",s:\"Status & kabar terbaru\"},\nes:{t:\"NYX no está disponible temporalmente\",d:\"No podemos conectar con nuestros servidores. Tus datos siguen cifrados en tu dispositivo. Esta página se recargará sola cuando volvamos.\",b:\"Reintentar\",n:\"Próxima comprobación en {n}s\",c:\"Comprobando…\",s:\"Estado y novedades\"},\npt:{t:\"O NYX está temporariamente indisponível\",d:\"Não conseguimos acessar nossos servidores agora. Seus dados continuam criptografados no seu dispositivo. Esta página recarrega sozinha quando voltarmos.\",b:\"Tentar novamente\",n:\"Próxima verificação em {n}s\",c:\"Verificando…\",s:\"Status e novidades\"}\n};\nvar lang=(navigator.language||\"en\").toLowerCase();\nvar k=lang.indexOf(\"id\")===0?\"id\":lang.indexOf(\"es\")===0?\"es\":lang.indexOf(\"pt\")===0?\"pt\":\"en\";\nvar T=L[k];document.documentElement.lang=k===\"pt\"?\"pt-BR\":k;\nvar $=function(i){return document.getElementById(i)};\n$(\"t\").textContent=T.t;$(\"d\").textContent=T.d;$(\"b\").textContent=T.b;\ndocument.title=\"NYX — \"+T.t;\nvar su=$(\"s\").getAttribute(\"href\");\nif(su&&su.indexOf(\"__\")!==0){$(\"s\").textContent=T.s;$(\"statusRow\").hidden=false}\nvar delay=15,left=delay,busy=false;\nfunction jitter(x){return Math.round(x*(0.7+Math.random()*0.6))}\nfunction check(){\n  if(busy)return;busy=true;$(\"n\").textContent=T.c;\n  fetch(\"/api/system/status\",{cache:\"no-store\",credentials:\"omit\"}).then(function(r){\n    var ct=r.headers.get(\"content-type\")||\"\";\n    if(r.ok&&ct.indexOf(\"json\")>-1){location.reload();return}\n    throw 0;\n  }).catch(function(){\n    busy=false;delay=Math.min(120,Math.round(delay*1.5));left=jitter(delay);tick();\n  });\n}\nfunction tick(){$(\"n\").textContent=T.n.replace(\"{n}\",left)}\nsetInterval(function(){\n  if(busy||document.hidden)return;\n  left--;if(left<=0){check()}else{tick()}\n},1000);\n$(\"b\").addEventListener(\"click\",function(){delay=15;check()});\ntick();\n})();\n</script>\n</body>\n</html>\n";

const CSP = "default-src 'none'; style-src 'sha256-zokyj9fYeKx8AhQzePdNHS6kGKcwQTDbOiqscY8PykU='; script-src 'sha256-1jIqzhWXwfJbCtOydh/ONN1jZoMMzbo+YP4KBGztqbI='; " +
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
