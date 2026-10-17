// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 §30.13 WS-I] Kontrak UI tautan berbagi profil.
 *
 * Sebelum ini modal membangun `/connect?u=…&i=<userId>&p=<profil terenkripsi>`,
 * sementara route `/u/:hashId` tidak punya produsen sama sekali — tautan pendek
 * WS-I tak bisa didapat pengguna. Test ini mengunci dua hal yang membuat
 * fiturnya benar-benar hidup:
 *
 *  1. QR DAN tombol salin memakai URL yang SAMA (`/u/<hashId>`), bukan dua
 *     bentuk berbeda yang salah satunya bisa tertinggal saat diubah;
 *  2. URL itu hanya membawa hashId — userId mentah (`i=`) dan blob profil
 *     terenkripsi (`p=`) tidak lagi ikut beredar di QR/tautan.
 *
 * Parser sisi konsumen (QR lama tetap hidup) diuji di
 * `usernameLink.test.ts` + `scanQrModal.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const toastSuccess = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      // Buang prop animasi agar tidak jadi atribut DOM yang tidak dikenal.
      const { children, initial, animate, exit, ...rest } = props;
      void initial; void animate; void exit;
      return React.createElement('div', rest as React.HTMLAttributes<HTMLDivElement>, children);
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

// react-qr-code: nilai QR harus bisa dibaca test (bukan digambar ke canvas).
vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) =>
    React.createElement('div', { 'data-testid': 'share-qr', 'data-value': value }),
}));

vi.mock('@components/ui/DefaultAvatar', () => ({
  default: ({ name }: { name?: string }) => React.createElement('div', null, name),
}));

const authState: { user: Record<string, unknown> | null } = { user: null };
vi.mock('@store/auth', () => ({
  useAuthStore: (selector: (s: { user: Record<string, unknown> | null }) => unknown) => selector(authState),
}));

vi.mock('@hooks/useUserProfile', () => ({
  useUserProfile: () => ({ name: 'Han', avatarUrl: null, description: null }),
}));

import ShareProfileModal from '../ShareProfileModal';

const HASH_43 = 'A'.repeat(43); // Argon2id klien (base64url 32 byte)
const USER_ID = 'user-raw-id';

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = {
    id: USER_ID,
    usernameHash: HASH_43,
    encryptedProfile: 'ENCRYPTED-PROFILE-BLOB',
  };
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});

describe('ShareProfileModal — tautan berbagi WS-I', () => {
  it('QR memakai `/u/<hashId>` dan tidak lagi memuat userId / profil terenkripsi', () => {
    render(<ShareProfileModal onClose={() => {}} />);

    const qr = screen.getByTestId('share-qr');
    const value = qr.getAttribute('data-value') ?? '';

    expect(value).toBe(`${window.location.origin}/u/${HASH_43}`);
    expect(value).not.toContain(USER_ID);
    expect(value).not.toContain('ENCRYPTED-PROFILE-BLOB');
    expect(value).not.toMatch(/[?&]i=/);
    expect(value).not.toMatch(/[?&]p=/);
  });

  it('tombol salin menulis URL yang sama dengan QR (satu sumber kebenaran)', async () => {
    render(<ShareProfileModal onClose={() => {}} />);
    const qrValue = screen.getByTestId('share-qr').getAttribute('data-value');

    fireEvent.click(screen.getByText('common:actions.copy_link'));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(qrValue);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('usernameHash tak berbentuk sah → tidak merender QR yang menyesatkan', () => {
    authState.user = { id: USER_ID, usernameHash: 'rusak', encryptedProfile: null };
    const { container } = render(<ShareProfileModal onClose={() => {}} />);
    expect(screen.queryByTestId('share-qr')).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
