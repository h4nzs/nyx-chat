# Pass 6 — Cakupan, metode, batasan

Tanggal: 2026-11-01. Basis: `537c432b` + perubahan **working tree** yang belum
di-commit (fix pass 5 untuk N5-02/N5-03/N5-04).

Laporan sebelumnya dibaca lebih dulu (`AUDIT_REPORT.md`, `pass-2`…`pass-5`).
Pass 6 tidak mengulang temuan yang sudah tertutup, dan memprioritaskan:

1. verifikasi fix pass 5 yang ada di working tree (bukan hanya yang di commit);
2. area yang lima pass sebelumnya nyatakan **belum dibaca**: `routes/auth.ts`
   (1875 baris) — register, login, refresh, recovery, device linking, logout,
   PoW, WebAuthn;
3. fokus khusus pass ini: **siklus sesi & pemulihan akun** (pembuatan sesi,
   rotasi refresh, revokasi, recovery, linking perangkat) — bagian dengan
   konsekuensi terbesar bila salah dan satu-satunya berkas auth yang belum
   pernah dibaca penuh.

## Metode

- `auth.ts` dibaca **penuh** (1875 baris, bukan grep), lalu setiap gate
  dicocokkan dengan helper yang dipanggilnya (`sessionUtils`, `refreshReplay`,
  `deviceLinking`, `powIdentity`, `sessionKeys`, `atRestSecrets`).
- Setiap jalur "revokasi" dibandingkan satu sama lain (`/logout`,
  `/logout-all`, `DELETE /api/sessions/:jti`) karena pola bug di repo ini
  berulang: token dicabut tetapi socket tetap hidup.
- Lima klaim "Verified-OK" paling berisiko diperiksa ulang: rotasi refresh +
  klasifikasi replay, tanda tangan recovery, alur linking, WebAuthn UV,
  identitas PoW.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | lihat `10-delta.md` §E |
| `npx tsc --noEmit` (web, termasuk working-tree fix SPQR) | lihat `10-delta.md` §E |
| `npx oxlint server/src web/src` | lihat `10-delta.md` §E |
| `pnpm --filter nyx-server run test` | lihat `10-delta.md` §E |
| `vitest run` 6 berkas SPQR (setelah tes working-tree diubah) | lihat `10-delta.md` §E |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright/WebTransport, `cargo test` (spqr-wasm & sidecar), `pnpm audit
  --prod` (F-13), tes Go KT, drill, fuzz, DR oracle.
- `routes/auth.ts` **sudah** dibaca penuh, tetapi perilaku nyata WebAuthn
  (authenticator hardware), Turnstile, dan attestation hanya diverifikasi dari
  kode — tidak ada upacara nyata yang dijalankan.
- `packages/keytrans-wasm-v2`, `metrics.rs` terperinci, dan `web/src/components/*`
  (sink XSS sudah disapu pass 1) tidak diulang.
