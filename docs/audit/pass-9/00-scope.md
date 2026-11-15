# Pass 9 — Cakupan, metode, batasan

Tanggal: 2026-11-02. Basis: `09bc7d04` **plus** satu perubahan working tree yang
belum di-commit (`web/src/lib/__tests__/ktMonitoring.test.ts`: batas waktu tes
naik ke 20 dtk, tanpa perubahan asersi). Laporan pass 1–8 dibaca lebih dulu.

Pass 9 memprioritaskan:

1. **verifikasi dua commit fix yang lahir dari pass 8** —
   `0a8a2e2b` (N8-01…N8-04) dan `09bc7d04` (N5-01, N7-01);
2. **mencari bug baru yang diperkenalkan fix itu**, terutama pada jalur yang
   belum pernah dijalankan: route KT anonim + OHTTP tanpa token, dan arsip era
   braid v2;
3. **fokus khusus: crypto worker & handshake** — arsip era SPQR dan KDF yang
   dipakai state KT.

## Metode

- Fix dibaca sebagai **diff**, lalu sebagai kode akhir; setiap klaim dipetakan ke
  pemanggilnya (`fetchKtProofAnonymously` → route → limiter → tag; rotate →
  arsip → `decryptSpqrMessage`; pin → `resolveConfig` → `commitKtConfigPin`).
- Untuk klaim kripto, **dijalankan**, bukan disimpulkan:
  - `crypto_kdf_derive_from_key` dipanggil dengan paket yang dipakai app
    (`libsodium-wrappers@^0.8.4`) untuk bentuk yang benar dan untuk seed
    berukuran salah;
  - arsip era v2 diuji dengan **modul WASM sungguhan** dari `/tmp/era-probe`
    (repo tidak disentuh): 2/3/5/10/20/40 pesan, plus urutan terbalik.
- Satu hipotesis saya (state arsip harus dimajukan agar pesan kedua terbuka)
  **terbantah oleh probe** dan dicatat sebagai Verified-OK, supaya pass
  berikutnya tidak mengulanginya.

## Yang dijalankan pada pass ini

| Cek | Hasil |
|---|---|
| `npx tsc --noEmit` (server) | **exit 0** |
| `npx tsc --noEmit` (web) | **exit 0** |
| `npx oxlint server/src web/src` | **0 error**, 229 warning |
| `tsx --test` ktQuery + ohttp + rateLimitIdentity | **36/36 lulus** |
| `vitest run` 5 berkas (ktSearchIndexKey, ktConfigPinScope, spqrEraArchive, spqrState, ktMonitoring) | **39/39 lulus** |
| `vitest run` 10 berkas KT + Dexie + spqrMessagePath | **100/100 lulus** |
| Probe KDF (bentuk benar) | 32 byte, deterministik, berbeda per seed |
| Probe KDF (seed 64/16/31 byte) | **THREW** `invalid key length` |
| Probe arsip era: 40 pesan + urutan terbalik | **semua key cocok** |

## Yang TIDAK dijalankan (batasan)

- E2E Playwright/WebTransport, fuzz, 58 tes Go KT, drill DR/restore KT, DR
  oracle, `cargo test` (sidecar maupun `packages/spqr-wasm`), seluruh suite
  vitest web.
- Dampak N9-01 dihitung dari kode (bucket 240/menit vs relay 120/menit), bukan
  dari uji beban dengan OHTTP menyala.
- N9-02 bergantung pada urutan hidrasi `useAuthStore`; urutan itu dibaca dari
  kode, tidak dipicu di browser.
- N9-03 (churn arsip) bergantung pada seberapa sering sesi X3DH baru lahir di
  lapangan — tidak diukur.
