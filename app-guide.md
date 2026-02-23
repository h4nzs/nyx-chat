# 🔥 0️⃣ Infrastructure Layer (Server + Network)

## 🧱 OS & Server Hardening

* [ ] OS up to date
* [ ] Unused packages dihapus
* [ ] UFW/iptables default deny
* [ ] SSH:

  * [ ] Password login disabled
  * [ ] Root login disabled
  * [ ] Key-based only
  * [ ] Non-default port (optional)
* [ ] Fail2ban aktif
* [ ] Automatic security update aktif

---

## 🌐 Cloudflare Tunnel Layer

* [ ] Origin port tidak expose publik
* [ ] Firewall hanya allow SSH
* [ ] Cloudflare Access aktif? (optional)
* [ ] No direct IP access
* [ ] Bot protection aktif
* [ ] Rate limiting rule di Cloudflare

---

# 🛡️ 1️⃣ NGINX Layer

## 🔐 TLS (kalau handle sendiri)

* [ ] TLS 1.2+ only
* [ ] Strong cipher suite
* [ ] OCSP stapling

(karena kita pakai tunnel, ini skip)

---

## 📦 Compression

* [ ] Gzip enabled
* [ ] No compression for sensitive dynamic responses

---

## 🧠 Caching

* [ ] Immutable hash assets only
* [ ] No caching for:

  * [ ] sw.js
  * [ ] HTML
  * [ ] API responses

---

## 🚨 Security Headers (WAJIB)

* [ ] `X-Frame-Options`
* [ ] `X-Content-Type-Options`
* [ ] `Referrer-Policy`
* [ ] `Permissions-Policy`
* [ ] `HSTS`
* [ ] `Content-Security-Policy`

  * [ ] NO unsafe-inline
  * [ ] NO unsafe-eval
  * [ ] No wildcard domain
  * [ ] No third-party JS (ideal)

---

# 🧠 2️⃣ Frontend (React + Vite)

## 🔐 XSS Defense

* [ ] No dangerouslySetInnerHTML
* [ ] Markdown sanitized
* [ ] DOMPurify strict config
* [ ] No dynamic script injection

---

## 🔑 Crypto Layer

* [ ] Key never stored in localStorage
* [ ] Key only in memory
* [ ] Key derived via PBKDF2/Argon2
* [ ] Salt per user
* [ ] Message encrypted client-side
* [ ] Server never sees plaintext

---

## 🧨 WASM Handling

* [ ] Libsodium properly loaded
* [ ] No eval fallback
* [ ] CSP compatible

---

## 📡 Service Worker

* [ ] No caching sensitive API
* [ ] No stale crypto logic
* [ ] Update properly handled

---

# 🔥 3️⃣ Backend (Node / Express)

## 🧱 Core Security

* [ ] Helmet enabled
* [ ] CORS strict origin
* [ ] Rate limit per IP
* [ ] Body size limit
* [ ] JSON parsing safe
* [ ] Trust proxy set (Cloudflare)

---

## 🧪 Validation

* [ ] Zod validation
* [ ] No raw req.body usage
* [ ] No unsanitized DB query

---

## 🔐 Auth

* [ ] JWT signed strong secret
* [ ] JWT expiration short
* [ ] Refresh token rotation
* [ ] HttpOnly cookie (if used)
* [ ] No token in localStorage

---

## 🧨 Error Handling

* [ ] No stack trace in production
* [ ] Central error handler last middleware
* [ ] No detailed DB error leak

---

# 🌊 4️⃣ WebSocket Layer

* [ ] Auth before connection accepted
* [ ] Rate limit messages
* [ ] Max payload size
* [ ] Disconnect on invalid JSON
* [ ] No broadcast leak
* [ ] No room ID guessing

---

# 🗄️ 5️⃣ Database

* [ ] Encrypted at rest
* [ ] No plaintext password
* [ ] Hash = argon2
* [ ] No SQL injection
* [ ] DB user minimal privilege
* [ ] Backup encrypted
* [ ] No public DB port

---

# 🔎 6️⃣ Logging & Monitoring

* [ ] No sensitive data in logs
* [ ] No decrypted content logged
* [ ] Structured logs
* [ ] Log rotation enabled
* [ ] Alert on:

  * [ ] Failed login spikes
  * [ ] 500 errors spike
  * [ ] WS flood

---

# 🧬 7️⃣ Supply Chain

* [ ] `pnpm audit` clean
* [ ] No deprecated packages
* [ ] Lockfile committed
* [ ] No random crypto library
* [ ] Dependencies pinned version

---

# 💀 8️⃣ Worst Case Scenario Planning

* [ ] Server compromised → attacker cannot decrypt message
* [ ] DB leaked → ciphertext only
* [ ] XSS attempt → blocked by CSP
* [ ] Tunnel hijack → still encrypted
* [ ] Analytics compromised → no key exposure

---

# 🧨 9️⃣ Attack Simulation Checklist

Simulate:

* [ ] XSS payload injection
* [ ] CSRF attempt
* [ ] WebSocket spam
* [ ] Large payload flood
* [ ] JWT tampering
* [ ] Expired token reuse
* [ ] Replay attack

---

# 🧠 10️⃣ Privacy Audit

* [ ] No analytics? (ideal)
* [ ] No tracking pixel
* [ ] No fingerprinting
* [ ] No IP logging long term
* [ ] GDPR notice (if needed)

---

# 📊 SECURITY MATURITY LEVEL

Kalau:

* Crypto strong
* CSP strict
* No third-party script
* Strict CORS
* Proper rate limit

→ lo masuk kategori **privacy-first secure app**

Kalau masih ada:

* unsafe-inline
* wildcard connect-src
* GA script

→ itu downgrade 2 level.

---

# 🚀 Mau Lebih Gila?

Kalau lo mau audit sampai paranoid-tier, next step:

* Threat modeling STRIDE
* CSP nonce-based
* Subresource Integrity
* Integrity check build output
* Automatic dependency scanning CI
* Runtime anomaly detection

