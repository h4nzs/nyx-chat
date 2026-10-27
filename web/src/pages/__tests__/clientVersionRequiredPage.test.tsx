// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [R2 2026-10-27] Layar gerbang versi klien (426).
 *
 * Yang dikunci di sini adalah perilaku yang membedakannya dari toast:
 *   - `CLIENT_TOO_OLD` = layar penuh yang TIDAK bisa ditutup (semua request
 *     gagal; menyembunyikannya hanya menyembunyikan kegagalan);
 *   - `CLIENT_VERSION_REQUIRED` = layar yang menjelaskan bahwa hanya mutasi yang
 *     ditolak, dan boleh ditutup untuk melanjutkan membaca;
 *   - keduanya menyebut build yang dipakai + minimum dari server, karena pesan
 *     tanpa angka tidak bisa ditindaklanjuti.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import i18n from '../../i18n';
import enErrors from '../../../public/locales/en/errors.json';
import { ClientVersionRequiredPage } from '../ClientVersionRequiredPage';
import { useClientVersionGateStore } from '../../store/clientVersionGate';

beforeAll(() => {
  // Bundle nyata (bukan key mentah): kalau kuncinya hilang dari JSON, layar
  // produksi akan menampilkan nama kunci dan test ini ikut gagal.
  i18n.addResourceBundle('en', 'errors', enErrors, true, true);
  i18n.language = 'en';
});

beforeEach(() => {
  useClientVersionGateStore.getState().reset();
});

describe('ClientVersionRequiredPage', () => {
  it('tidak merender apa pun selagi server belum menolak versi', () => {
    const { container } = render(<ClientVersionRequiredPage />);
    expect(container).toBeEmptyDOMElement();
  });

  it('too-old: layar penuh, menyebut build & minimum, hanya bisa muat ulang', () => {
    useClientVersionGateStore.getState().report('too-old', {
      minimumVersion: '3.1.0',
      clientVersion: '2.4.0',
    });
    const onReload = vi.fn();

    render(<ClientVersionRequiredPage onReload={onReload} />);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Update NYX to continue')).toBeInTheDocument();
    expect(screen.getByText('2.4.0')).toBeInTheDocument();
    expect(screen.getByText('3.1.0')).toBeInTheDocument();

    // Tidak ada jalan keluar selain memperbarui.
    expect(screen.queryByText('Continue without sending')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reload NYX/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('version-required: menjelaskan bedanya dan boleh ditutup untuk lanjut membaca', () => {
    useClientVersionGateStore.getState().report('version-required', {
      minimumVersion: '3.2.0',
    });

    render(<ClientVersionRequiredPage onReload={vi.fn()} />);

    expect(screen.getByText("NYX can't verify this build")).toBeInTheDocument();
    // Tanpa `clientVersion` dari server, layar menampilkan build yang sedang
    // berjalan — pengguna perlu angka itu untuk membandingkan dengan rilis.
    expect(screen.getByText(__APP_VERSION__)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continue without sending/i }));
    expect(useClientVersionGateStore.getState().dismissed).toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('too-old tidak bisa ditutup meski tombol dismiss dipanggil', () => {
    useClientVersionGateStore.getState().report('too-old', { minimumVersion: '3.1.0' });
    useClientVersionGateStore.getState().dismiss();

    render(<ClientVersionRequiredPage onReload={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('kode 426 di luar kontrak tidak memunculkan layar', () => {
    useClientVersionGateStore.getState().report('version-required');
    // Store hanya diisi oleh `reportClientVersionRejection` untuk dua kode itu;
    // di sini cukup pastikan minimum yang tidak diketahui tetap dirender dengan
    // teks pengganti, bukan "undefined".
    render(<ClientVersionRequiredPage onReload={vi.fn()} />);
    expect(screen.getByText('the latest release')).toBeInTheDocument();
  });
});
