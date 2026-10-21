// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx.app.my.id].

/**
 * [docs/35 Fase 3] Generate keypair gateway OHTTP (P-256).
 *
 * Output sengaja berupa dua baris env, bukan file: private key hanya boleh
 * hidup di `/root/nyx-app/.env` (0600) dan tidak boleh masuk repo. Rotasi kunci
 * = generate ulang + deploy, dan klien akan menolak config baru sampai pin-nya
 * direset eksplisit (fail-closed).
 */

import { generateOhttpKeyPair } from '@nyx/shared';

const { privateKey, publicKey } = await generateOhttpKeyPair();
console.log(`OHTTP_PRIVATE_KEY=${Buffer.from(privateKey).toString('base64url')}`);
console.log(`OHTTP_PUBLIC_KEY=${Buffer.from(publicKey).toString('base64url')}`);
