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

# 2. Gabungkan beberapa root menjadi satu berkas PEM (dedupe per fingerprint,
#    menolak sertifikat non-CA)
node scripts/attestation-roots.mjs bundle --out ops/attestation/roots.pem \
  vendor-a-root.pem vendor-b-root.der

# 3. Arahkan server ke berkas itu
#    ABUSE_ATTESTATION_ROOTS_FILE=/etc/nyx/attestation-roots.pem
```

Sumber root yang lazim:

- **FIDO Metadata Service** — <https://mds3.fidoalliance.org/> (blob JWT; ambil
  `metadataStatement.attestationRootCertificates` dari entri yang relevan).
  Verifikasi tanda tangan JWT terhadap root MDS sesuai spesifikasi FIDO sebelum
  mempercayai isinya.
- **Halaman vendor**: Yubico (attestation roots), Apple (attestation root CA),
  Google (Android Key Attestation root), Microsoft (TPM AIK roots).

NYX sengaja **tidak** mem-vendor sertifikat root di repo ini: itu data
operasional yang berputar/kedaluwarsa, dan memasukkannya ke kode berarti
mempercayai salinan yang tidak pernah ditinjau. Yang di-vendor adalah
**mekanismenya** (`webauthnAttestation.ts`) dan alat bantu di atas.

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
