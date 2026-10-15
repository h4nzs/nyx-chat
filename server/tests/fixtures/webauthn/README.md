# Fixture attestation WebAuthn (KUNCI UJI)

Dihasilkan `server/scripts/webauthn-attestation-fixtures.ts`. Jangan dipakai
di produksi: kunci privat di sini hanya untuk test.

| Berkas | Isi |
|---|---|
| `root-ca.der` | root CA uji (`basicConstraints=CA:TRUE`) — pengganti root TPM/FIDO |
| `leaf-aik.der` | leaf `OU=Authenticator Attestation` dengan EKU AIK TPM `2.23.133.8.3` |
| `leaf-plain.der` | leaf `OU=Authenticator Attestation` tanpa EKU (test negatif fmt `tpm`) |
| `leaf-*.key.pem` | kunci ECDSA P-256 pasangan leaf (untuk menandatangani attestation di test) |

Fingerprint SHA-256 root uji: `8D:26:A0:A4:BC:1B:EA:5F:1A:F7:8D:46:12:A8:54:34:71:6F:7A:62:37:08:50:99:18:3F:91:56:80:90:BB:56`

Regenerasi: `pnpm --filter nyx-server exec tsx scripts/webauthn-attestation-fixtures.ts`
