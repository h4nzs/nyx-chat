// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3 / docs/43 §43.12.4] Generate keypair gateway OHTTP.
 *
 *   pnpm --filter nyx-server run ohttp-key:generate
 *   pnpm --filter nyx-server run ohttp-key:generate -- --suite=xwing
 *
 * Output sengaja berupa dua baris env, bukan file: private key hanya boleh
 * hidup di `/root/nyx-app/.env` (0600) dan tidak boleh masuk repo. Slot hybrid
 * memakai nama env `OHTTP_XWING_*`; slot rotasi berikutnya ditambahkan manual
 * dengan nama `OHTTP_NEXT_*` / `OHTTP_XWING_NEXT_*`.
 */

import { OHTTP_KEM_XWING, generateOhttpKeyPair } from '@nyx/shared';

const xwing = process.argv.includes('--suite=xwing');
const { privateKey, publicKey } = await generateOhttpKeyPair(
  xwing ? OHTTP_KEM_XWING : undefined,
);
const prefix = xwing ? 'OHTTP_XWING' : 'OHTTP';
console.log(`${prefix}_PRIVATE_KEY=${Buffer.from(privateKey).toString('base64url')}`);
console.log(`${prefix}_PUBLIC_KEY=${Buffer.from(publicKey).toString('base64url')}`);
