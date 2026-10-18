# Root attestation perangkat (WS-H)

Dokumen ini menjawab satu pertanyaan operasional: **bagaimana rantai attestation
dari perangkat keras nyata bisa lolos verifikasi** tanpa mematikan pemeriksaan
rantai (`ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN=off`, default).

## Kenapa `x5c` saja tidak cukup

Attestation WebAuthn `direct` mengirim `attStmt.x5c` — daftar sertifikat DER
**leaf → atas**. Bentuk yang dikirim perangkat nyata berbeda-beda:

| Authenticator | `fmt` | Isi `x5c` yang umum |
|---|---|---|
| Android Key Attestation | `android-key` | leaf + intermediate (+ root Google pada sebagian perangkat) |
| Windows Hello / TPM 2.0 | `tpm` | leaf AIK + intermediate; root Microsoft biasanya **tidak** ikut |
| YubiKey (PIV/FIDO2) | `packed` | leaf + intermediate Yubico; root tidak ikut |
| Apple platform (Secure Enclave) | `apple` | leaf + intermediate; root Apple tidak ikut |
| Chromium virtual authenticator (DEV) | `packed` | **satu** sertifikat self-signed (`CN=Chromium Batch Certificate`) |

Karena itu verifikasi NYX punya dua tingkat:

1. **Pemeriksaan internal** — setiap sertifikat ditandatangani sertifikat di
   atasnya, masih berlaku, leaf bukan CA, dan leaf membawa atribut yang sesuai
   (`TPM` juga wajib EKU AIK `2.23.133.8.3`).
2. **Anchor** — rantai harus berakhir di sesuatu yang dipercaya operator:
   - **root yang dipin** (`ABUSE_ATTESTATION_ROOTS_FILE`), baik root itu ikut di
     `x5c` maupun tidak (jalur dibangun dengan kunci publik root), atau
   - **fingerprint yang dipin persis** (`ABUSE_ATTESTATION_ROOTS`) untuk root
     yang ikut di `x5c`, atau sertifikat self-signed tunggal (mis. authenticator
     virtual Chrome di lingkungan dev).

Tanpa pin, hanya rantai yang **menyertakan root self-signed** yang lolos
(`anchoredBy: self-signed`). Itu membuktikan konsistensi internal, **bukan**
identitas vendor: siapa pun bisa membuat root sendiri. Untuk produksi, isi
root bundle.

## Membuat bundle root

Alat bantu (tanpa dependensi): `scripts/attestation-roots.mjs`.

```bash
# 1. Lihat isi sertifikat (PEM atau DER) + fingerprint SHA-256
node scripts/attestation-roots.mjs inspect vendor-root.pem

# 2. Segarkan bundle dari sumber vendor (unduh + VERIFIKASI + filter):
node scripts/attestation-roots.mjs refresh --out /etc/nyx/attestation-roots.pem

# 3. Periksa kesehatan bundle yang sudah ada (nextUpdate, root kedaluwarsa,
#    sha256 vs metadata). --strict = exit 2 bila ada peringatan (untuk cron).
node scripts/attestation-roots.mjs check --bundle /etc/nyx/attestation-roots.pem

# 4. Arahkan server ke berkas itu
#    ABUSE_ATTESTATION_ROOTS_FILE=/etc/nyx/attestation-roots.pem
```

`refresh` mengunduh tiga sumber secara default (`--sources mds,android,apple`):

| Sumber | URL | Yang diverifikasi |
|---|---|---|
| FIDO MDS | `https://mds.fidoalliance.org/` | JWS (RS256/ES256) dengan kunci leaf `x5c`; setiap tautan rantai; masa berlaku; identitas leaf `CN=mds.fidoalliance.org`; pin TOFU fingerprint rantai di metadata |
| Android | `https://android.googleapis.com/attestation/root` | PEM/JSON dari TLS resmi; CA + masa berlaku |
| Apple WebAuthn | `https://www.apple.com/certificateauthority/Apple_WebAuthn_Root_CA.pem` | PEM dari TLS resmi; CA + masa berlaku |

Filter yang dipakai (dan dicatat per sumber di metadata): **hanya CA**
(`basicConstraints=CA:TRUE`), **hanya yang masih berlaku** (`--keep-expired`
untuk memaksa), **dedup per SHA-256**, dan seluruh root dari entri MDS berstatus
`REVOKED`, `ATTESTATION_KEY_COMPROMISE`, `USER_KEY_REMOTE_COMPROMISE`,
`USER_KEY_PHYSICAL_COMPROMISE`, atau `USER_VERIFICATION_BYPASS` dibuang. Root
kedaluwarsa/non-CA dibuang karena keduanya tidak bisa membangun jalur —
menyimpannya hanya membuat bundle tampak lengkap sambil tetap gagal dipakai.

Setiap `refresh` menulis **dua** berkas: bundle PEM dan `<bundle>.meta.json`
berisi `generatedAt`, `nextUpdate` MDS, `serialNo`, sha256 bundle, jumlah/dropped
per sumber, daftar fingerprint + `validTo`, dan fingerprint rantai MDS. Metadata
inilah yang dibaca peringatan boot dan alert.

Perilaku pin yang perlu diketahui:

- Rantai MDS nyata berhenti di **GlobalSign Root R46** yang tidak ikut `x5c`.
  Karena itu, selain verifikasi tanda tangan + identitas leaf, `refresh` mem-pin
  fingerprint rantai ke metadata (TOFU). Rantai yang berubah **gagal** kecuali
  `--accept-new-mds-chain`; periksa manual dulu.
- `--mds-root <pem>` mem-pin anchor GlobalSign secara eksplisit; rantai yang
  tidak berakhir di sana ditolak. Ini menutup celah TOFU dan disarankan untuk
  operator yang jalur unduhannya tidak sepenuhnya dipercaya.
- `--mds-blob <file>` / `--android-file` / `--apple-file` dipakai untuk
  mereproduksi refresh tanpa jaringan (mis. audit offline). Verifikasi JWS tetap
  berjalan pada blob yang diberikan.

Unduhan mengulang sendiri untuk `429`/`5xx` (menghormati `Retry-After`, maksimum
tiga percobaan) — MDS memang membalas 429 bila dipanggil berdekatan, dan refresh
cron yang gagal karena itu akan meninggalkan bundle basi sampai minggu berikutnya.

`--dry-run` menjalankan unduhan + verifikasi + filter lalu mencetak apa yang
**akan** ditulis tanpa menyentuh berkas — dipakai untuk mencoba pin rantai baru
sebelum mengganti bundle produksi. Opsi yang tidak dikenal **ditolak**, bukan
diabaikan: salah ketik seperti `check --file <bundle>` gagal dengan exit 1,
tidak diam-diam memeriksa bundle default lalu exit 0 di cron.

NYX sengaja **tidak** mem-vendor sertifikat root di repo ini: itu data
operasional yang berputar/kedaluwarsa, dan memasukkannya ke kode berarti
mempercayai salinan yang tidak pernah ditinjau. Yang di-vendor adalah
**mekanismenya** (`webauthnAttestation.ts`, `attestationRootsHealth.ts`) dan alat
bantu di atas.

## Perilaku runtime

- Berkas dibaca sekali lalu di-cache berdasarkan `path + mtime`; mengganti isi
  berkas langsung terpakai tanpa restart (selama server tidak di-restart dengan
  env lama).
- Berkas yang hilang/kosong **melempar** error kebijakan saat pendaftaran
  (fail-visible). Jangan biarkan kesalahan konfigurasi menjadi "tidak ada root".
- Pins berlaku untuk **semua** akun baru selama gerbang attestation menyala;
  pastikan bundle mencakup semua model perangkat yang ingin didukung.
- Saat rotasi root vendor, tulis bundle berisi root lama **dan** baru, verifikasi
  pendaftaran perangkat lama & baru, lalu hapus root lama.
- Peringatan boot akan muncul bila attestation menyala tetapi tidak ada root
  dipin, atau bila `ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN=on`
  (`utils/startupSignals.ts`).
- [2026-10-17] `utils/attestationRootsHealth.ts` membaca bundle + metadata tiap
  boot dan memperingatkan bila: metadata tidak ada, `nextUpdate` MDS sudah lewat
  atau tinggal ≤30 hari, ada root kedaluwarsa (atau ≤30 hari lagi), atau sha256
  bundle berbeda dari metadata (berkas diganti manual). Gauge
  `nyx_attestation_roots_expired_certs` dan
  `nyx_attestation_roots_next_update_timestamp_seconds` mengisi alert
  `NyxAttestationRootExpired` / `NyxAttestationRootBundleStale`; penolakan
  `root_not_trusted` punya alert sendiri (`NyxAttestationRootNotTrusted`) plus
  aturan rasio penolakan (`NyxAttestationRejectionRateHigh`). Lihat
  `ops/prometheus/alerts.yml` grup `nyx-app`.
- Peringatan boot hanya dihitung **saat start**; setelah `refresh`, restart
  `nyx-api` agar gauge (dan alert) ikut memperbarui, meskipun bundle baru sudah
  dipakai tanpa restart.

## Perangkat tanpa authenticator platform

Kebijakan pendaftaran meminta `authenticatorAttachment: 'platform'` +
`userVerification: 'required'`, artinya **Touch ID / Windows Hello / biometrik
Android-iOS**. Desktop Linux (Firefox maupun Chrome) tidak punya platform
authenticator: `isUserVerifyingPlatformAuthenticatorAvailable()` bernilai
`false` dan `navigator.credentials.create()` langsung melempar `NotAllowedError`
dengan pesan "The request is not allowed by the user agent or the platform in
the current context…" — tanpa dialog apa pun muncul.

Klien (`web/src/lib/registerAttestation.ts`) memeriksa kemampuan itu **sebelum**
upacara, jadi user mendapat pesan `registration_attestation_no_platform`, bukan
`NotAllowedError` mentah. Untuk perangkat seperti ini pilihannya:

- daftar dari ponsel atau laptop berbiometrik (origin & RP ID sama,
  `app.nyx-app.my.id`), lalu masuk dari desktop; atau
- pasang security key eksternal **setelah** opsi pendaftaran diubah ke
  `authenticatorAttachment: 'either'` (belum didukung kode saat ini), atau
- matikan gerbang untuk sementara (`ABUSE_REQUIRE_ATTESTATION=off`) — Turnstile
  dan `ABUSE_REGISTRATION_GUARD` tetap berjalan.

Jangan menganggap `NotAllowedError` sebagai "user menolak izin" tanpa memeriksa
hasil preflight: di Linux desktop penyebabnya struktural, dan menyarankan user
"coba lagi" tidak akan pernah berhasil.

## Mode passkey (dipakai deployment ini sejak 2026-10-18)

Ponsel juga tidak otomatis lolos: passkey default Android/iOS adalah kredensial
**tersinkron** di Google/Apple Password Manager — `fmt: none`,
`credentialDeviceType: multiDevice`, `backedUp: true`, AAGUID Google Password
Manager `ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4`. Penolakannya terlihat di log:

```
[WS-H] Attestation akun baru ditolak: { reason: 'NOT_HARDWARE_ATTESTATION',
  tier: 'none', deviceType: 'multiDevice', backedUp: true }
```

Karena itu gate ketat **hanya** bisa dipenuhi security key FIDO2 atau kredensial
device-bound. Bila operator memilih menerima passkey (seperti deployment ini),
tiga env harus diubah bersamaan:

```bash
ABUSE_ATTESTATION_ALLOW_NONE=on      # terima fmt: none
ABUSE_ATTESTATION_ALLOW_SYNCED=on    # terima multiDevice
ABUSE_ATTESTATION_FORMATS=packed,tpm,android-key,apple,fido-u2f,none
```

`ALLOW_NONE=on` tanpa `none` di `FORMATS` tetap ditolak
(`ATTESTATION_FORMAT_NOT_ALLOWED`) — urutan pemeriksaan kebijakan memang begitu,
dan itu dikunci unit test.

Konsekuensi yang harus disadari: gate tidak lagi membuktikan perangkat keras,
hanya keberadaan authenticator WebAuthn dengan user verification; sybil
resistance bertumpu pada Turnstile + `ABUSE_REGISTRATION_GUARD`. Akun yang lolos
lewat `tier: none` dibuat **`isVerified=false`** (`server/src/routes/auth.ts`),
sehingga upload dan fitur ber-verifikasi lain tetap tertutup sampai user
menambahkan authenticator sungguhan. Peringatan boot
`ABUSE_ATTESTATION_ALLOW_NONE=on: ...` sengaja muncul di setiap start supaya
keadaan ini tidak terlupakan.

## Perangkat tanpa authenticator sama sekali

Desktop Linux tanpa Touch ID/Windows Hello **dan** tanpa security key tidak bisa
menjalankan upacara WebAuthn — bukan karena kebijakan menolak, tapi karena tidak
ada authenticator yang bisa dipanggil. Untuk perangkat seperti ini ada jalur
tersendiri:

```bash
ABUSE_ATTESTATION_ALLOW_UNATTESTED=on
```

Alurnya: klien mencoba upacara lebih dulu; bila perangkat menyatakan tidak punya
platform authenticator (`ATTESTATION_NO_PLATFORM_AUTHENTICATOR`) atau browser
tidak mendukung WebAuthn, klien mengirim ulang pendaftaran dengan
`attestationUnavailable: true`. Server menerimanya **hanya** bila env di atas
`on` dan permintaan attestation berasal dari kebijakan global — bila yang
meminta adalah heuristik burst sybil per-ASN, jalur ini ditolak
(`mayWaiveAttestation`), supaya ASN yang sedang dibanjiri tidak bisa lolos hanya
dengan mengaku tidak punya authenticator.

Jaminan yang tersisa untuk akun hasil jalur ini:

- `isVerified=false` → upload (`SANDBOX_UPLOAD_RESTRICTION`) dan pencarian luas
  (`SANDBOX_SEARCH_RESTRICTION`) tetap tertutup; user bisa menambahkan
  authenticator nanti untuk naik status.
- Turnstile + `ABUSE_REGISTRATION_GUARD` tetap berlaku; metrik
  `nyx_attestation_registration_total{result="unattested"}` membuat populasinya
  terlihat, dan peringatan boot mengingatkan bahwa gerbang ini tidak membuktikan
  perangkat.
- Pembatalan dialog oleh user (`NotAllowedError`) **tidak** jatuh ke jalur ini —
  klien hanya memakainya untuk kegagalan kapabilitas perangkat.

## Menjaga bundle tetap segar (cron)

MDS memberi `nextUpdate` (mis. 2026-11-01) — lewat tanggal itu daftar root yang
bisa diverifikasi mungkin sudah tidak lengkap. Contoh jadwal mingguan:

```bash
0 4 * * 1 cd /opt/nyx && node scripts/attestation-roots.mjs refresh \
  --out /etc/nyx/attestation-roots.pem >> /var/log/nyx-roots-refresh.log 2>&1
```

`check` cocok untuk cron terpisah yang hanya ingin peringatan (`--strict`
menjadikan peringatan exit 2 sehingga cron mengirim email):

```bash
0 6 * * * cd /opt/nyx && node scripts/attestation-roots.mjs check \
  --bundle /etc/nyx/attestation-roots.pem --strict
```

## Lingkungan dev / E2E

Authenticator virtual Chromium mengirim satu sertifikat self-signed
(`CN=Chromium Batch Certificate`), bukan rantai vendor. Dua cara menguji jalur
ketat:

```bash
# (a) pin persis sertifikat itu lewat fingerprint
ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN=off \
ABUSE_ATTESTATION_ROOTS="AA:BB:..." ...

# (b) atau masukkan sertifikatnya ke bundle
node scripts/attestation-roots.mjs bundle --out /tmp/chromium-root.pem cert.pem
ABUSE_ATTESTATION_ROOTS_FILE=/tmp/chromium-root.pem ...
```

Jangan pernah memakai `ABUSE_ATTESTATION_ALLOW_UNVERIFIED_CHAIN=on` sebagai
ganti pin di produksi: itu menerima sertifikat self-signed buatan siapa pun
sebagai tier "hardware".
