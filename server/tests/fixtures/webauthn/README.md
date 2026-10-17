# Fixture attestation WebAuthn (KUNCI UJI)

Dihasilkan `server/scripts/webauthn-attestation-fixtures.ts`. Jangan dipakai
di produksi: kunci privat di sini hanya untuk test.

| Berkas | Isi |
|---|---|
| `root-ca.der` | root CA uji (`basicConstraints=CA:TRUE`) — pengganti root TPM/FIDO |
| `intermediate-ca.der` | intermediate CA uji — rantai nyata sering berhenti di sini (root tidak ikut x5c) |
| `leaf-aik.der` | leaf `OU=Authenticator Attestation` dengan EKU AIK TPM `2.23.133.8.3` |
| `leaf-chained.der` | leaf yang ditandatangani intermediate (test jalur 3 tingkat) |
| `leaf-plain.der` | leaf `OU=Authenticator Attestation` tanpa EKU (test negatif fmt `tpm`) |
| `leaf-*.key.pem` | kunci ECDSA P-256 pasangan leaf (untuk menandatangani attestation di test) |

Fingerprint SHA-256 root uji: `43:8F:DD:FD:19:5A:6A:77:6D:02:40:E9:B5:73:FD:5B:79:68:90:10:D0:7A:60:D5:46:30:67:1B:D9:06:91:22`

Regenerasi: `pnpm --filter nyx-server exec tsx scripts/webauthn-attestation-fixtures.ts`
