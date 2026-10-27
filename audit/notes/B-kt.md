# B — Key Transparency

HEAD `25b1699`. Diperiksa: `server/kt-query` (Go: store, `/search`,
`/distinguished`, `/monitor`, snapshot), `packages/keytrans-wasm`,
`web/src/lib/{ktMonitoring,ktGossip,peerIdentityTrust,keyTransparency}.ts`,
`server/src/utils/ktIdentityLog.ts`, `server/src/jobs/ktSnapshot.ts`,
`server/src/routes/keys.ts` (bagian `/kt/*`).

## Yang terbukti benar

- **Mismatch tidak pernah menjadi pin.** `peerIdentityTrust.ts:209-246`: bila
  kunci yang disajikan ≠ kunci log, record ditulis dengan `ktMismatch` dan
  `status: 'changed'`; `acceptPendingPeerIdentity` tetap diperlukan. Kunci log
  tidak pernah dipakai diam-diam.
- **Monitor fail-closed.** `runKtMonitorOnce` menulis state hanya setelah
  `verifyMonitor` sukses (`ktMonitoring.ts`), dan state disegel `ENC1:`.
- **Split-view terdeteksi** dari pasangan `(treeSize, root)` di payload gossip
  yang disegel — bukan dari field yang bisa dipalsukan server tanpa terlihat.
- **Satu pemilik LevelDB** (flock) dipertahankan; snapshot harian dibuka ulang
  dan dibandingkan tree head/root sebelum diarsipkan (`kt-query`), unggahan R2
  hidup di proses API (`jobs/ktSnapshot.ts`), bukan di Go.
- **Pin vendor** Signal diperiksa `check-vendor.sh` (lulus di baseline §05).

## Temuan terkait

- **F-09** — kegagalan tak terduga di jalur verifikasi (WASM/jaringan/parse)
  menjadi `verdict: null` tanpa jejak yang terlihat pengguna; klaim "kunci
  terverifikasi log" lebih luas daripada kenyataan. Ini bukan bug alur
  pengiriman (memang disengaja tidak memblokir), melainkan **permukaan status
  yang hilang**.
- **C8** (fail-closed KT) karena itu berstatus *terbukti untuk monitor & pin,
  gagal-terbuka tanpa peringatan untuk error*.

## Batas

- `server/kt-query/build.sh test` lulus (31 test) di baseline, tetapi saya
  **tidak** mengaudit verifier bukti baris-per-baris, tidak menjalankan
  `cmd/kt-client` upstream, dan tidak menguji interop dua auditor.
- Snapshot/restore drill tidak dijalankan terhadap data nyata.
