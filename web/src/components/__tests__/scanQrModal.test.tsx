// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.13 WS-I] Jalur masuk QR.
 *
 * Link pendek `/u/<hashId>` hanya berguna kalau pemindai benar-benar
 * mengurainya: sebelum perbaikan ini QR berisi `/u/<hashId>` diabaikan (hanya
 * `/connect?u=…&i=…&p=…` yang diterima), sehingga tautan WS-I yang dibagikan
 * dari modal profil tidak pernah bisa dipakai lewat kamera.
 *
 * Yang dikunci test ini:
 *  1. QR `/u/<hashId>` → `onScanSuccess('?u=<hashId>')` (hanya hashId yang
 *     diteruskan) dan kamera dihentikan;
 *  2. QR lama `/connect?u=…&i=…&p=…` → query diteruskan APA ADANYA (QR yang
 *     sudah beredar tetap bekerja);
 *  3. QR bukan tautan NYX / segmen hash tak sah → tanpa callback, kamera tetap
 *     memindai (tidak ada navigasi salah).
 *
 * `html5-qrcode` palsu: yang diuji adalah wiring URL → query `/connect`, bukan
 * dekoder QR-nya.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      const { children, initial, animate, exit, ...rest } = props;
      void initial; void animate; void exit;
      return React.createElement('div', rest as React.HTMLAttributes<HTMLDivElement>, children);
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

/** Callback sukses + panggilan stop dari instance scanner palsu. */
const scannerCalls: {
  onDecoded: ((text: string) => Promise<void>) | null;
  stop: Mock;
} = { onDecoded: null, stop: vi.fn() };

vi.mock('html5-qrcode', () => {
  class Html5Qrcode {
    isScanning = false;
    constructor(_elementId: string) {}
    start(
      _camera: unknown,
      _config: unknown,
      onDecoded: (text: string) => Promise<void>,
      _onFailure: () => void
    ) {
      scannerCalls.onDecoded = onDecoded;
      return Promise.resolve();
    }
    stop() {
      scannerCalls.stop();
      return Promise.resolve();
    }
    clear() {}
  }
  return { Html5Qrcode };
});

import ScanQRModal from '../ScanQRModal';

const HASH_43 = 'A'.repeat(43);
const HASH_64 = 'ab'.repeat(32);

function renderScanner() {
  const onScanSuccess = vi.fn();
  render(<ScanQRModal onClose={() => {}} onScanSuccess={onScanSuccess} />);
  return onScanSuccess;
}

/** Tunggu scanner palsu siap (komponen menunda start 200 ms). */
async function decodedCallback() {
  await waitFor(() => expect(scannerCalls.onDecoded).toBeTruthy(), { timeout: 3000 });
  return scannerCalls.onDecoded!;
}

beforeEach(() => {
  vi.clearAllMocks();
  scannerCalls.onDecoded = null;
});

describe('ScanQRModal', () => {
  it('QR link pendek `/u/<hashId>` → meneruskan hashId saja dan menghentikan kamera', async () => {
    const onScanSuccess = renderScanner();
    const onDecoded = await decodedCallback();

    await onDecoded(`https://nyx-app.my.id/u/${HASH_43}`);

    await waitFor(() => expect(onScanSuccess).toHaveBeenCalledWith(`?u=${HASH_43}`));
    expect(scannerCalls.stop).toHaveBeenCalledTimes(1);
  });

  it('QR blind index 64 hex (echo server) juga diterima', async () => {
    const onScanSuccess = renderScanner();
    const onDecoded = await decodedCallback();

    await onDecoded(`https://app.nyx-app.my.id/u/${HASH_64}`);

    await waitFor(() => expect(onScanSuccess).toHaveBeenCalledWith(`?u=${HASH_64}`));
  });

  it('QR lama `/connect?u=…&i=…&p=…` diteruskan apa adanya', async () => {
    const onScanSuccess = renderScanner();
    const onDecoded = await decodedCallback();

    const legacy = `https://nyx-app.my.id/connect?u=${HASH_43}&i=user-1&p=blob`;
    await onDecoded(legacy);

    await waitFor(() => expect(onScanSuccess).toHaveBeenCalledWith(`?u=${HASH_43}&i=user-1&p=blob`));
  });

  it('QR non-NYX / segmen hash tak sah diabaikan tanpa menghentikan pemindaian', async () => {
    const onScanSuccess = renderScanner();
    const onDecoded = await decodedCallback();

    await onDecoded('https://example.com/');
    await onDecoded('teks biasa bukan url');
    await onDecoded('https://nyx-app.my.id/u/rusak');

    expect(onScanSuccess).not.toHaveBeenCalled();
    expect(scannerCalls.stop).not.toHaveBeenCalled();
  });
});
