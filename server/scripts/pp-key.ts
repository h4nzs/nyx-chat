// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/37 §37.3.3] Generate kunci issuer Privacy Pass (RSA-2048, RSA-PSS
 * SHA-384) dan simpan sebagai JWK di env.
 *
 * Pemakaian:
 *   pnpm --filter nyx-server run pp-key:generate            # cetak ke stdout
 *   pnpm --filter nyx-server run pp-key:generate -- --write  # tulis ke .env
 *
 * `--write` hanya menambah/mengganti baris `PP_ISSUER_PRIVATE_JWK=` di
 * `server/.env`; baris lain tidak disentuh, dan nilai tidak pernah dicetak
 * ke stdout (hanya panjangnya). Rotasi = generate ulang; token lama menjadi
 * tidak sah sampai klien meminta token baru (issuer keyId berubah).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RSABSSA } from '@cloudflare/blindrsa-ts'

const write = process.argv.includes('--write')

const pair = await RSABSSA.SHA384.generateKey({
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
})
const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
const jwkJson = JSON.stringify(privateJwk)

if (!write) {
  console.log(jwkJson)
  process.exit(0)
}

const envPath = path.resolve(process.cwd(), '.env')
const line = `PP_ISSUER_PRIVATE_JWK=${jwkJson}`
const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const lines = existing.split('\n')
const index = lines.findIndex((entry) => entry.startsWith('PP_ISSUER_PRIVATE_JWK='))

if (index >= 0) lines[index] = line
else {
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  lines.push(line, '')
}

writeFileSync(envPath, lines.join('\n'), { mode: 0o600 })
console.log(`PP_ISSUER_PRIVATE_JWK ${index >= 0 ? 'diperbarui' : 'ditambahkan'} di ${envPath} (${jwkJson.length} byte).`)
