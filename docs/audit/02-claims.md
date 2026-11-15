# 02 — Audit Klaim (README/docs vs kode)

Setiap baris = klaim yang dibuat repo, lalu status verifikasi. `VERIFIED` hanya bila saya membaca jalur kodenya sendiri.

| # | Klaim | Sumber | Status | Bukti / catatan |
|---|---|---|---|---|
| C1 | Server tidak pernah menerima plaintext pesan | README | **VERIFIED** | `Message.content` diisi dari payload klien apa adanya (`realtimeHandlers.ts:343-370`); tidak ada jalur yang men-dekripsi di server. `server/src/lib/sodium.ts` hanya dipakai untuk seal at-rest/relay, bukan untuk membuka pesan. |
| C2 | Username di-hash Argon2id **client-side**, server hanya menyimpan `HMAC(pepper, hash)` | README §1, §2 | **VERIFIED** | Worker op `hashUsername` (`crypto.worker.ts:1285`) Argon2id 64 MB; `identifierLookupCandidates()` hanya mengembalikan HMAC (`atRestSecrets.ts`), dan komentar R5 menyatakan nilai mentah tidak lagi menjadi kandidat. |
| C3 | Tidak ada email/telepon/userAgent/IP tersimpan | README, docs/28 | **VERIFIED (skema)** | `RefreshToken` tidak punya `ipAddress`/`userAgent` (`schema.prisma`); rate-limit key = `clientIpTag()` (HMAC). Tidak ditemukan kolom email/phone di schema. |
| C4 | Profil ("Ghost Profiles") dienkripsi lokal, server hanya blob | README §3 | **VERIFIED** | `User.encryptedProfile String?`; tidak ada dekripsi di server (grep `decryptProfile` hanya di `web/`). |
| C5 | Mandatory PQ: bundle tanpa `signingKeyV2` ditolak klien | README, docs/04 §4.4 | **VERIFIED (klien) / PARTIAL (server)** | Klien mewajibkan `signingKeyV2` pada X3DH v2. Server **tidak** mewajibkan: `signingKeyV2`/`signatureV2` opsional di skema upload bundle (`keys.ts:80-95`, "opsional agar klien lama tetap jalan"). Jadi server masih menerima bundle klasik; penolakan ada di klien. |
| C6 | PQX3DH memakai X-Wing (ML-KEM-768 + X25519) | README | **VERIFIED** | `pq_box_seal_v2`/`x3dh_v2_*` di worker memakai `crypto_kem_xwing_*`; `docs/04 §4.4`. |
| C7 | Handshake mengautentikasi inisiator (tanda tangan ML-DSA-65) | docs/04 §4.4 | **VERIFIED** | Penerima memverifikasi sebelum menurunkan state; klien juga membandingkan `initiatorSigningKeyV2` dengan bundle peer yang sudah dicek KT (`messagePipeline.ts:355-370`). |
| C8 | `pqSignature` pada signed pre-key **tidak** diverifikasi di jalur v2 | docs/04 §4.4 | **VERIFIED (sesuai dokumen)** | Dinyatakan eksplisit sebagai keputusan; bukan temuan. |
| C9 | 8 KB padding tiap pesan | README, docs/04 §4.10 | **VERIFIED (jalur kode)** | `PADDING_BLOCK_SIZE` dipakai sebelum AEAD di `dr_ratchet_encrypt`/`group_ratchet_encrypt` (`crypto.worker.ts:1693-1700`, `1926-1929`). |
| C10 | Ratchet v2 hanya dipakai setelah peer membuktikan bisa membaca (`ackV: 2`); kill switch tidak mematikan pembacaan | README, docs/04 §4.5.1 | **PARTIAL (tak diverifikasi runtime)** | Konstanta & negosiasi ada (`spqrNegotiation.ts`, `SERVER_CAPABILITIES`); e2e `spqr.spec.ts` tidak dijalankan. |
| C11 | KT: proof diverifikasi di WASM sebelum pinning; monitor fail-closed | README, docs/34 | **PARTIAL** | Server hanya meneruskan protobuf base64url (`routes/ktQuery.ts`), konsisten dengan klaim "API tidak mem-parse proof". Verifikasi aktual ada di `packages/keytrans-wasm-v2` — **tidak** saya audit (bukan TS aplikasi). |
| C12 | Satu perangkat aktif ditegakkan server-side per-opcode | docs/03 §3.3 | **PARTIAL → lihat F-05** | Dicek di `handleUpstreamMessage` (`redisBridge.ts:180-200`) dan AUTH; tetapi `isActiveDeviceAllowed` **fail-open** saat Redis error (`redisBridge.ts:159-161`). Jadi klaim "enforced" punya celah saat Redis down. |
| C13 | CSRF double-submit per klien via `x-nyx-installation-id` | docs/03 §3.3 | **VERIFIED** | `app.ts:300-330` (`getSessionIdentifier`), klien mengirim header yang sama (`api.ts:220-240`). `POST /api/keys` berada **di bawah** lapisan CSRF. |
| C14 | Rate limit memakai Lua INCR+EXPIRE atomik | AGENTS, docs/03 §3.5 | **VERIFIED** | `RATE_LIMIT_LUA` + `createCheckRateLimit`; `conversations.ts:104-112` memakai pola yang sama untuk sandbox. |
| C15 | `trust proxy` tepat 2 hop | docs/03 §3.5 | **VERIFIED** | `app.ts:83`. |
| C16 | Pesan disimpan maksimum 14 hari | README §4, docs/05 | **VERIFIED** | REST: `messages.ts:47,180-190`; WT: `realtimeHandlers.ts:330-340` dengan default TTL yang sama. |
| C17 | REST `POST /api/messages` adalah fallback kirim | docs/05 §5.4 | **FALSE (drift)** | Klien **tidak pernah** POST ke `/api/messages` — hanya GET dan DELETE (`web/src/store/message.ts`). Saat offline, pesan masuk `offlineQueueDb` dan dikirim lewat transport saat reconnect (`message.ts:1401-1620`). Rute REST tetap ter-mount dan, karena tak pernah mengisi `deleteSecret`, tidak bisa di-unsend (F-03). |
| C18 | `.nyxvault` (plaintext) sudah dihapus; hanya `.nyxbak` | README §Vault | **VERIFIED (tidak ada referensi hidup)** | Tidak ditemukan `.nyxvault` di `web/src`; `backupFormat.ts`/`backupRestore.ts` adalah jalur aktif. |
| C19 | Attachment: `secretstream`, key di dalam pesan E2EE | docs/04 §4.9 | **VERIFIED** | `file_encrypt`/`file_decrypt` (`crypto.worker.ts:1032-1160`). |
| C20 | Upload hanya blob terenkripsi, ukuran dikunci server di presign | docs/28, `uploads.ts` | **VERIFIED** | `fileType !== 'application/octet-stream'` → 400; `validateUploadSize` + `ContentLength` ditandatangani (`uploads.ts:40-70`). Catatan: TTL URL tidak dibatasi (F-06). |
| C21 | Metric tidak memuat identitas | README, docs/10 §10.12 | **TIDAK DIUJI** | `metrics.ts` mengklaim menolak label beridentitas; tidak saya baca penuh. |
| C22 | "Signal Protocol SPQR" / `pqdr` | deskripsi repo (tidak ada di working tree) | **CANNOT VERIFY** | Yang benar-benar ada: Double Ratchet hybrid (PQ dari langkah KEM) + SPQR braid v2 opsional. **Bukan** Double Ratchet klasik Signal sepenuhnya (tidak ada X3DH klasik), dan `pqdr` hanya nama konsep di docs/04 §4.7 (burner). Wording README ("Double Ratchet with PQ forward secrecy from the KEM step" + "SPQR adds PCS") **akurat**; wording "Signal Protocol" akan **over-state** bila dipakai tanpa kualifikasi. |
| C23 | Dua relay (WT & WSS) memakai `SERVER_CAPABILITIES` yang sama | AGENTS, docs/04 §4.5.1 | **VERIFIED** | `shared` sebagai sumber; `utils/transportCapability.ts` dipakai gateway; `realtimeHandlers.ts` dipakai kedua jalur (paritas rate limit terlihat di komentar & kode). |

## Ringkas

- Klaim inti privasi (C1–C4, C9, C13–C16, C19–C20) **terverifikasi** di kode.
- Dua klaim yang **tidak** sepenuhnya benar: **C17** (REST fallback) dan **C12** (single-device saat Redis gagal). Keduanya masuk temuan.
- Klaim PQ (C5) benar di sisi klien tetapi server tetap menerima bundle v1 — perlu diputuskan apakah itu memang desain kompatibilitas atau celah.
