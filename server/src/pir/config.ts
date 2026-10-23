// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/35 Fase 4b] Konfigurasi proxy PIR.
 *
 * Default MATI: tanpa `PIR_ENABLED=1`, router `/api/pir` tidak dipasang sama
 * sekali. Saat hidup, API hanya mem-proxy ke sidecar ChalametPIR di loopback;
 * tidak ada kripto PIR di proses Node.
 */

export interface PirConfig {
  /** Origin sidecar PIR, tanpa path/query/credentials. */
  serviceUrl: string;
}

/** Fitur hidup? Dipakai agar mati = 404, bukan 403. */
export function isPirEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PIR_ENABLED === '1';
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * Muat konfigurasi dari env. `null` = fitur mati (perilaku default).
 * Melempar bila diaktifkan tetapi URL sidecar tidak aman/tidak valid.
 */
export function loadPirConfig(env: NodeJS.ProcessEnv = process.env): PirConfig | null {
  if (!isPirEnabled(env)) return null;

  const raw = env.PIR_SERVICE_URL ?? 'http://127.0.0.1:9470';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PIR: PIR_SERVICE_URL bukan URL yang valid');
  }
  if (url.protocol !== 'http:') {
    throw new Error('PIR: PIR_SERVICE_URL harus http:// ke sidecar loopback');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('PIR: PIR_SERVICE_URL hanya boleh menunjuk loopback');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PIR: PIR_SERVICE_URL tidak boleh memuat credentials/path/query/hash');
  }
  return { serviceUrl: url.origin };
}
