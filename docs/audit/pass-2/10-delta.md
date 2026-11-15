# Pass 2 — Laporan delta

Basis: `73a5d656` (commit perbaikan atas temuan pass 1).
Laporan pass 1: `docs/audit/AUDIT_REPORT.md`. Detail regresi: `20-regressions.md`.
Sapuan otorisasi (fokus pass ini): `30-authz-sweep.md`. Metode/batasan: `00-scope.md`.

## Ringkasan satu paragraf

Tujuh dari tiga belas temuan pass 1 tertutup dengan bukti kode dan tes (F-03,
F-04, F-06, F-07, F-08, F-09, F-10), dua tertutup sebagian (F-02 dengan residual,
F-12 kosmetik), dan satu **gagal dalam praktik** meski gate-nya benar (F-01 →
REG-1) — begitu pula F-05/F-11, yang gate-nya benar tetapi memakai sumber bukti
yang tidak ada pada data nyata (REG-2). Tidak ada temuan Critical. Dua regresi
bertingkat **High** karena mematikan fitur privasi dan pemulihan kunci secara
hening. Tiga temuan baru semuanya **Low**, dari area yang di pass 1 belum dibaca.

## A. Diperbaiki dan terverifikasi

| ID | Perbaikan | Bukti | Verdict |
|---|---|---|---|
| F-02 | `authorizeGroupSystemWrite`: anggota (baris keanggotaan) **atau** admin capability; target disaring `filterConversationMembers` + cap 200 | `server/src/utils/groupRealtimeAuth.ts:82-127`, `server/src/network/realtimeHandlers.ts:651-760` | **Tertutup**; residual N-03 |
| F-03 | `POST /api/messages` menerima `deleteSecret` (32-128 char) dan menyimpan hash-nya | `server/src/routes/messages.ts:185,261`; DELETE tetap memverifikasi `credentialTokenMatches` (`:349`) | **Tertutup** |
| F-04 | Single-active-device fail-closed saat baca gagal, hasil error **tidak** di-cache | `server/src/network/redisBridge.ts:173-197`; `server/tests/activeDeviceFailClosed.test.ts` | **Tertutup** |
| F-06 | `urlTtl` dan retensi presign di-clamp; burner mengabaikan `urlTtl` klien | `server/src/utils/uploadLimits.ts`, `server/src/routes/uploads.ts:88,96,152` | **Tertutup** |
| F-07 | Paginasi memakai kursor `seq` + `limit` di-clamp | `server/src/routes/messages.ts:56-66` | **Tertutup** |
| F-08 | Hapus objek R2 memvalidasi key utuh (`isOwnedObjectKey`) | `server/src/routes/messages.ts:364-382` | **Tertutup** |
| F-09 | Cap pada `targetRecipients` (500 zod / `MAX_TYPING_TARGETS`), batch receipt, target metadata | `server/src/routes/messages.ts:191-194`, `server/src/network/realtimeHandlers.ts:1255`, `groupRealtimeAuth.ts:37` | **Tertutup** |
| F-10 | Wildcard `https://*.cloudflare.com` dibuang dari `scriptSrc` | `server/src/app.ts:100-124` | **Tertutup**; `'unsafe-inline'` tetap (residual dicatat) |

Catatan F-02: perbaikan ini **tidak** merusak distribusi kunci pertama grup —
pembuat grup memang belum punya baris keanggotaan, dan cabang admin capability
menutup kasus itu dengan benar.

## B. Masih terbuka

| ID | Status | Catatan |
|---|---|---|
| F-12 | **Tidak diverifikasi ulang** | Info/kosmetik (variabel mati di jalur X3DH). `oxlint` masih melaporkan 236 warning `no-unused-vars`; tidak ada penurunan yang bisa diatribusikan ke commit ini. |
| F-13 | **Tidak diverifikasi** (butuh jaringan) | 3 advisory dependensi di pass 1; `pnpm-lock.yaml` berubah (versi marketing/server di-bump). Jalankan `pnpm audit --prod` sebelum rilis. |

## C. REGRESI — gate benar, kontrak/data tidak

| ID | Temuan | Tingkat | Bukti |
|---|---|---|---|
| REG-1 | `message:view_once_opened` tidak pernah lolos gate: klien mengirim `targetRecipient: message.senderId` (id lawan bicara) tanpa `deleteSecret`, server mensyaratkan `targetRecipient === userId` + baris receipt. Pesan view-once tidak terhapus di server, `message:viewed` tidak terkirim, sementara UI sudah menandai "sudah dilihat". | **High** | `web/src/components/Lightbox.tsx:38` vs `server/src/network/realtimeHandlers.ts:889-920` |
| REG-2 | Filter target typing & `session:fulfill_response` memakai `collectPresencePeers` yang bersumber dari baris `UserHiddenConversation`. Baris itu **tidak pernah dibuat untuk pembuat percakapan** dan **tidak ada sama sekali untuk 1:1** (`startConversation` tidak mengirim token). Akibat: typing di 1:1 mati, typing pembuat grup mati, dan pemulihan kunci sesi 1:1 selalu ditolak (hening, hanya `console.warn`). | **High** | `server/src/utils/presencePeers.ts:77-101`, `server/src/routes/conversations.ts:238-244`, `server/src/network/realtimeHandlers.ts:530-537,608-615`, `web/src/store/conversation.ts:578-584` |

Rincian, dampak, dan perbaikan minimum: `20-regressions.md`.

## D. Temuan baru

| ID | Tingkat | Temuan |
|---|---|---|
| N-01 | Low | `GET /api/users/:id` tanpa autentikasi (`users.ts:685`, dipasang tanpa auth di `app.ts:504`) — oracle keberadaan akun + `isVerified`/`hasCompletedOnboarding` ke pemanggil anonim. |
| N-02 | Low | Filter typing memakai peer **global**, bukan anggota `conversationId` di payload (`realtimeHandlers.ts:514-537`) — noise lintas percakapan, bukan kebocoran. |
| N-03 | Low | `findMembership` mengabaikan `expiresAt`/`tokenEpoch` (`routingIdentity.ts:196-200`) → baris anggota kedaluwarsa masih boleh menulis baris SYSTEM. |

## E. Tes & checks pass ini

- `npx tsc --noEmit` (server): **exit 0**.
- `npx oxlint server/src web/src`: **0 error**, 236 warning.
- `pnpm --filter nyx-server run test`: **739 tes, 737 lulus, 0 gagal, 2 skip** (97 s).
  Angka ini **tidak** membuktikan REG-1/REG-2 aman: tes baru memakai fake yang
  langsung mengembalikan "peer" dan payload view-once berbentuk ideal, bukan
  bentuk yang dikirim klien.
- Web vitest tidak dijalankan ulang (tidak ada berkas `web/src` yang berubah
  sejak pass 1 lulus 134/134 berkas).

## F. Rekomendasi urutan tindak lanjut

1. **REG-1** — dua baris klien (`targetRecipient: <id sendiri>` + `deleteSecret`
   bila ada) + satu tes yang memakai payload `Lightbox` apa adanya.
2. **REG-2** — ganti sumber bukti dari peer global ke keanggotaan **per
   percakapan**; untuk 1:1 pakai receipt/`Message` terbaru, atau tulis baris
   keanggotaan pembuat saat create.
3. N-01 `requireAuth` satu baris.
4. N-03 `expiresAt`/`tokenEpoch` pada `findMembership`.
5. F-13: jalankan `pnpm audit --prod` sebelum rilis.

## G. Yang justru tetap kuat (diperiksa ulang, bukan dikutip)

Otorisasi sesi (`revokeSessionFamily`), backup R2 (kunci diturunkan dari userId,
ukuran/ttl dikunci di tanda tangan), preview SSRF (`redirect: 'manual'` + cap
5 MB + wajib `image/*`), stories (blocklist + rate limit atomik), blind delete
(`credentialTokenMatches` + `isOwnedObjectKey`), dan gate grup REST
(token → admin → status kode yang dikunci tes).
