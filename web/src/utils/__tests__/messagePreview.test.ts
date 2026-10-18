// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * Regresi: preview daftar chat.
 *
 *  • Pesan kontrol (`CALL_INIT`, `GHOST_SYNC`, `PROFILE_SYNC`, `COVER`,
 *    `GROUP_KEY`, `UNSEND`, `reaction_remove`, `SYSTEM_KEY_REQUEST`,
 *    `STORY_KEY`) tidak pernah boleh menjadi preview — dulu sebagian di
 *    antaranya jatuh ke cabang "teks biasa" sehingga payload JSON mentah
 *    tampil di daftar chat, dan sebagian lain menghasilkan preview kosong →
 *    UI menampilkan "No messages yet" untuk percakapan yang punya riwayat.
 *  • Pesan "silent" yang memang membawa teks TETAP terlihat (bubble volume-x).
 *  • `pickPreviewLastMessage` harus tahan terhadap baris kontrol di urutan
 *    teratas (itu sumber preview flaky saat sync).
 */
import { describe, it, expect } from 'vitest';
import { isPreviewableMessage, pickPreviewLastMessage, withPreview } from '../messagePreview';
import type { Message } from '@nyx/shared';

let counter = 0;

function msg(partial: Partial<Message> & { content?: string | null }): Message {
  counter += 1;
  return {
    id: `m${counter}`,
    conversationId: 'c1',
    senderId: 'peer',
    createdAt: new Date(Date.UTC(2026, 0, 1, 10, 0, counter)).toISOString(),
    content: null,
    reactions: [],
    ...partial,
  } as Message;
}

function payload(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

describe('withPreview — pesan kontrol tidak pernah jadi preview', () => {
  const controlTypes = [
    'CALL_INIT',
    'GHOST_SYNC',
    'PROFILE_SYNC',
    'COVER',
    'GROUP_KEY',
    'UNSEND',
    'reaction_remove',
    'SYSTEM_KEY_REQUEST',
  ];

  for (const type of controlTypes) {
    it(`${type} → preview kosong + isSilent`, () => {
      const result = withPreview(msg({ content: payload(type), seq: 5 }));
      expect(result.preview).toBe('');
      expect(result.isSilent).toBe(true);
      expect(isPreviewableMessage(result)).toBe(false);
    });
  }

  it('STORY_KEY: (prefix lama) tetap tersembunyi', () => {
    const result = withPreview(msg({ content: 'STORY_KEY:abc:def' }));
    expect(result.preview).toBe('');
    expect(isPreviewableMessage(result)).toBe(false);
  });

  it('JSON tanpa tipe kontrol dikembalikan sebagai teks apa adanya', () => {
    const raw = payload('story_reply', { text: 'halo' });
    expect(withPreview(msg({ content: raw })).preview).toBe(raw);
  });
});

describe('withPreview — pesan yang memang terlihat', () => {
  it('teks biasa → preview = teks', () => {
    const result = withPreview(msg({ content: 'Halo dunia' }));
    expect(result.preview).toBe('Halo dunia');
    expect(isPreviewableMessage(result)).toBe(true);
  });

  it('payload "silent" bertipe teks TETAP tampil (bukan pesan kontrol)', () => {
    const result = withPreview(msg({ content: payload('silent', { text: 'psst' }) }));
    expect(result.preview).toBe('psst');
    expect(result.content).toBe('psst');
    expect(result.isSilent).toBe(true);
    expect(isPreviewableMessage(result)).toBe(true);
  });

  it('reaksi → "Reacted 👍"', () => {
    const result = withPreview(msg({ content: payload('reaction', { emoji: '👍' }) }));
    expect(result.preview).toBe('Reacted 👍');
    expect(isPreviewableMessage(result)).toBe(true);
  });

  it('edit → prefiks ✎', () => {
    const result = withPreview(msg({ content: payload('edit', { text: 'revisi' }) }));
    expect(result.preview).toBe('✎ revisi');
  });

  it('lampiran: gambar / video / berkas', () => {
    expect(withPreview(msg({ fileUrl: 'blob:x', fileType: 'image/png' })).preview).toBe('📷 Image');
    expect(withPreview(msg({ fileUrl: 'blob:x', fileType: 'video/mp4' })).preview).toBe('🎥 Video');
    expect(withPreview(msg({ fileUrl: 'blob:x', fileName: 'laporan.pdf' })).preview).toBe('laporan.pdf');
  });
});

describe('isPreviewableMessage', () => {
  it('nisan (isDeletedLocal / tanpa isi) tidak layak jadi preview', () => {
    expect(isPreviewableMessage(msg({ content: null, isDeletedLocal: true } as Partial<Message>))).toBe(false);
    expect(isPreviewableMessage(msg({ content: null }))).toBe(false);
    expect(isPreviewableMessage(null)).toBe(false);
    expect(isPreviewableMessage(undefined)).toBe(false);
  });

  it('view-once tetap layak (UI punya label khusus)', () => {
    // View-once biasanya membawa konten terenkripsi/placeholder; status
    // isViewOnce sendiri yang membuat baris itu berarti.
    expect(isPreviewableMessage(msg({ content: null, isViewOnce: true } as Partial<Message>))).toBe(true);
  });
});

describe('pickPreviewLastMessage', () => {
  it('melewati pesan kontrol terbaru dan mengambil pesan terlihat sebelumnya', () => {
    const real = msg({ content: 'pesan asli', seq: 10 });
    const ghost = msg({ content: payload('GHOST_SYNC'), seq: 11 });
    const picked = pickPreviewLastMessage([real, ghost]);
    expect(picked?.id).toBe(real.id);
    expect(picked?.preview).toBe('pesan asli');
  });

  it('input tidak harus terurut — yang menang adalah urutan pesan, bukan urutan array', () => {
    const older = msg({ content: 'lama', seq: 3 });
    const newer = msg({ content: 'baru', seq: 9 });
    expect(pickPreviewLastMessage([newer, older])?.id).toBe(newer.id);
    expect(pickPreviewLastMessage([older, newer])?.id).toBe(newer.id);
  });

  it('semua kandidat kontrol/nisan → null (baru boleh disebut "belum ada pesan")', () => {
    const rows = [
      msg({ content: payload('CALL_INIT'), seq: 1 }),
      msg({ content: payload('UNSEND'), seq: 2 }),
      msg({ content: null, isDeletedLocal: true } as Partial<Message>),
    ];
    expect(pickPreviewLastMessage(rows)).toBeNull();
    expect(pickPreviewLastMessage([])).toBeNull();
  });

  it('tidak memutasi baris masukan', () => {
    const original = msg({ content: payload('silent', { text: 'halo' }) });
    const snapshot = { ...original };
    pickPreviewLastMessage([original]);
    expect(original).toEqual(snapshot);
  });
});
