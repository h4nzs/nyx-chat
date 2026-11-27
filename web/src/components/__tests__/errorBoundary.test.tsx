// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * ErrorBoundary adalah satu-satunya jaring terakhir saat render React gagal.
 * Tanpa tes, regresi pada boundary berarti halaman putih, bukan layar pemulihan.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import enCommon from '../../../public/locales/en/common.json';
import ErrorBoundary from '../ErrorBoundary';

beforeAll(() => {
  i18n.addResourceBundle('en', 'common', enCommon, true, true);
  i18n.language = 'en';
});

function Boom(): never {
  throw new Error('boom from child');
}

describe('ErrorBoundary', () => {
  it('merender children selama tidak ada error', () => {
    render(
      <ErrorBoundary>
        <div>konten aman</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText('konten aman')).toBeInTheDocument();
  });

  it('menangkap error render dan menampilkan layar pemulihan', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('System Malfunction')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reboot System/i })).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'Error caught by boundary:',
      expect.stringContaining('boom from child'),
      '\nStack:',
      expect.anything(),
    );

    consoleError.mockRestore();
  });

  it('memakai fallback kustom bila disediakan', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<div>fallback khusus</div>}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByText('fallback khusus')).toBeInTheDocument();
    expect(screen.queryByText('System Malfunction')).toBeNull();
    consoleError.mockRestore();
  });
});
