// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.12 WS-H] Generator fixture attestation perangkat keras untuk test.
 *
 * Kenapa fixture, bukan authentikator: attestation TPM/packed dengan `x5c` hanya
 * bisa dibangkitkan oleh perangkat keras sungguhan (TPM/SE/Titan), dan itu tidak
 * ada di CI. Yang **bisa** dibangkitkan di sini adalah bagian yang menentukan
 * keputusan keamanan — sertifikat X.509 sungguhan (rantai root→leaf, EKU AIK TPM
 * `2.23.133.8.3`, `basicConstraints`, masa berlaku) dan tanda tangan ECDSA
 * sungguhan atas `authenticatorData || clientDataHash`. Test kemudian menandatangani
 * respons registrasi WebAuthn `packed` yang **asli secara format** dengan kunci
 * leaf ini, dan `@simplewebauthn/server` memverifikasinya seperti perangkat nyata.
 *
 * Yang **tidak** dibuktikan fixture ini (tetap residual jujur, `docs/30` §30.20):
 * kunci privat benar-benar berada di dalam silikon, dan rantai benar-benar
 * berakhir di root FIDO/TPM yang di-pin produksi (di sini root-nya root uji yang
 * dibuat skrip ini, dan fingerprint-nya dipakai test untuk jalur "root dipin").
 *
 * Kunci di direktori fixture adalah **kunci uji** — jelas terpisah dari kunci
 * produksi dan tidak berguna di luar test.
 *
 * Pemakaian (butuh `openssl` di PATH):
 *   pnpm --filter nyx-server exec tsx scripts/webauthn-attestation-fixtures.ts
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT_DIR = resolve(process.cwd(), 'tests/fixtures/webauthn');
/** EKU AIK TPM (`id-tcg-kp-AIKCertificate`). */
const TPM_AIK_EKU_OID = '2.23.133.8.3';

const openssl = (args: string[], cwd: string): void => {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
};


interface CertSpec {
  name: string;
  cn: string;
  /** EKU tambahan; kosong = tidak ada EKU sama sekali. */
  eku?: string;
  /** Sertifikat ini CA (untuk root) atau leaf. */
  ca?: boolean;
  /**
   * OU sertifikat. Attestation `packed` **wajib** ber-OU `Authenticator
   * Attestation` (spec FIDO): tanpa itu `@simplewebauthn/server` menolak sebelum
   * sempat memeriksa tanda tangan — jadi fixture tanpa OU bukan fixture packed.
   */
  ou?: string;
}

function makeCert(cwd: string, spec: CertSpec, issuer?: { cert: string; key: string }): { der: string; key: string } {
  const keyPath = `${spec.name}.key`;
  const csrPath = `${spec.name}.csr`;
  const crtPath = `${spec.name}.crt`;
  const derPath = `${spec.name}.der`;

  // Bentuk subject yang dituntut spec FIDO untuk attestation `packed`/`full`:
  // `OU=Authenticator Attestation`, `O` dan `CN` tidak kosong, dan `C` dua huruf
  // (ISO 3166). Tanpa salah satunya, pustaka menolak sebelum memeriksa tanda tangan.
  const subject = spec.ou
    ? `/C=US/O=NYX Test Only/OU=${spec.ou}/CN=${spec.cn}`
    : `/C=US/O=NYX Test Only/CN=${spec.cn}`;

  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath], cwd);
  openssl(['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', subject], cwd);

  const extensions = [`basicConstraints=critical,CA:${spec.ca ? 'TRUE' : 'FALSE'}`];
  extensions.push(spec.ca ? 'keyUsage=critical,keyCertSign,cRLSign' : 'keyUsage=critical,digitalSignature');
  if (spec.eku) extensions.push(`extendedKeyUsage=${spec.eku}`);
  // SAN dirName adalah bentuk yang dipakai attestation TPM (nama AIK); menambahkannya
  // membuat fixture lebih mirip sertifikat nyata, bukan hanya struktur minimal.
  extensions.push('subjectAltName=dirName:dir_sect', '[dir_sect]', `CN=${spec.cn}`);
  const extPath = `${spec.name}.ext`;
  writeFileSync(join(cwd, extPath), `${extensions.join('\n')}\n`);

  if (!issuer) {
    // `openssl req -x509` tidak menerima `-extfile`; ekstensi root diberi lewat
    // `-addext` (root tidak butuh SAN).
    openssl(
      [
        'req', '-new', '-x509', '-key', keyPath, '-out', crtPath, '-days', '3650',
        '-subj', subject,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      ],
      cwd
    );
  } else {
    openssl(
      ['x509', '-req', '-in', csrPath, '-CA', issuer.cert, '-CAkey', issuer.key, '-CAcreateserial', '-out', crtPath, '-days', '3650', '-extfile', extPath],
      cwd
    );
  }
  openssl(['x509', '-in', crtPath, '-outform', 'DER', '-out', derPath], cwd);
  return { der: derPath, key: keyPath };
}

function main(): void {
  const work = mkdtempSync(join(tmpdir(), 'nyx-attest-fixtures-'));
  try {
    // Root CA uji (meniru root TPM/FIDO yang di-pin operator).
    const root = makeCert(work, { name: 'root-ca', cn: 'NYX Test Attestation Root', ca: true });
    const issuer = { cert: join(work, root.der.replace(/\.der$/, '.crt')), key: join(work, root.key) };

    // Intermediate CA: rantai perangkat nyata (Android/YubiKey/Apple/TPM) sering
    // dikirim sebagai leaf + intermediate, dengan root TIDAK ikut di `x5c`.
    const intermediate = makeCert(
      work,
      { name: 'intermediate-ca', cn: 'NYX Test Attestation Intermediate', ca: true },
      issuer
    );
    const intermediateIssuer = {
      cert: join(work, intermediate.der.replace(/\.der$/, '.crt')),
      key: join(work, intermediate.key),
    };

    // Leaf ber-EKU AIK TPM: bentuk yang dipakai attestation `tpm` (dan `packed` TPM).
    const aik = makeCert(
      work,
      { name: 'leaf-aik', cn: 'NYX Test AIK', ou: 'Authenticator Attestation', eku: TPM_AIK_EKU_OID },
      issuer
    );

    // Leaf yang ditandatangani intermediate — dipakai test jalur 3 tingkat.
    const chained = makeCert(
      work,
      { name: 'leaf-chained', cn: 'NYX Test Chained Leaf', ou: 'Authenticator Attestation', eku: TPM_AIK_EKU_OID },
      intermediateIssuer
    );
    // Leaf tanpa EKU: dipakai test negatif "fmt tpm tanpa EKU AIK".
    const plain = makeCert(
      work,
      { name: 'leaf-plain', cn: 'NYX Test Plain', ou: 'Authenticator Attestation' },
      issuer
    );

    mkdirSync(OUT_DIR, { recursive: true });
    for (const name of ['root-ca', 'intermediate-ca', 'leaf-aik', 'leaf-plain', 'leaf-chained']) {
      writeFileSync(join(OUT_DIR, `${name}.der`), readFileSync(join(work, `${name}.der`)));
    }
    writeFileSync(join(OUT_DIR, 'leaf-aik.key.pem'), readFileSync(join(work, 'leaf-aik.key')));
    writeFileSync(join(OUT_DIR, 'leaf-plain.key.pem'), readFileSync(join(work, 'leaf-plain.key')));
    writeFileSync(join(OUT_DIR, 'leaf-chained.key.pem'), readFileSync(join(work, 'leaf-chained.key')));

    // Fingerprint dihitung Node (API yang sama dengan verifikasi di produksi),
    // bukan dari keluaran teks openssl.
    const fingerprint = new X509Certificate(readFileSync(join(OUT_DIR, 'root-ca.der'))).fingerprint256;
    writeFileSync(
      join(OUT_DIR, 'README.md'),
      [
        '# Fixture attestation WebAuthn (KUNCI UJI)',
        '',
        'Dihasilkan `server/scripts/webauthn-attestation-fixtures.ts`. Jangan dipakai',
        'di produksi: kunci privat di sini hanya untuk test.',
        '',
        `| Berkas | Isi |`,
        `|---|---|`,
        `| \`root-ca.der\` | root CA uji (\`basicConstraints=CA:TRUE\`) — pengganti root TPM/FIDO |`,
        `| \`intermediate-ca.der\` | intermediate CA uji — rantai nyata sering berhenti di sini (root tidak ikut x5c) |`,
        `| \`leaf-aik.der\` | leaf \`OU=Authenticator Attestation\` dengan EKU AIK TPM \`${TPM_AIK_EKU_OID}\` |`,
        `| \`leaf-chained.der\` | leaf yang ditandatangani intermediate (test jalur 3 tingkat) |`,
        `| \`leaf-plain.der\` | leaf \`OU=Authenticator Attestation\` tanpa EKU (test negatif fmt \`tpm\`) |`,
        `| \`leaf-*.key.pem\` | kunci ECDSA P-256 pasangan leaf (untuk menandatangani attestation di test) |`,
        '',
        `Fingerprint SHA-256 root uji: \`${fingerprint}\``,
        '',
        'Regenerasi: `pnpm --filter nyx-server exec tsx scripts/webauthn-attestation-fixtures.ts`',
        '',
      ].join('\n')
    );

    console.log(`fixture ditulis ke ${OUT_DIR}`);
    console.log(`root fingerprint: ${fingerprint}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
