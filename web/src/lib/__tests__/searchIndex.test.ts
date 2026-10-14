// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/30 WS-F §30.10 poin 3] Unit test indeks pencarian in-memory.
 *
 * Yang dijaga di sini bukan sekadar "bisa mencari", tetapi bahwa semantiknya
 * tetap sama dengan pencarian substring lama (`plainText.includes(query)`) —
 * termasuk query yang memotong batas kata — supaya percepatan indeks tidak
 * mengubah hasil yang dilihat user.
 */
import { describe, it, expect } from 'vitest';
import {
  MessageSearchIndex,
  SEARCH_INDEX_MAX_MESSAGES,
  searchRowFingerprint,
  tokenizeSearchText,
} from '../searchIndex';

/** Cek kandidat benar-benar superset dari hasil pencarian substring lama. */
function matchesSubstring(index: MessageSearchIndex, conversationId: string, query: string, texts: Record<string, string>): void {
  const legacy = Object.entries(texts)
    .filter(([, text]) => text.toLowerCase().includes(query.toLowerCase()))
    .map(([id]) => id);
  const candidates = index.candidates(conversationId, query).filter((id) => texts[id] !== undefined);
  for (const id of legacy) {
    expect(candidates).toContain(id);
  }
}

describe('tokenizeSearchText', () => {
  it('memecah huruf/angka Unicode dan menormalkan ke huruf kecil', () => {
    expect(tokenizeSearchText('Halo, Dunia!')).toEqual(['halo', 'dunia']);
    expect(tokenizeSearchText('jalan-jalan_2x')).toEqual(['jalan', 'jalan', '2x']);
    expect(tokenizeSearchText('café')).toEqual(['café']);
    expect(tokenizeSearchText('!!!')).toEqual([]);
    expect(tokenizeSearchText('')).toEqual([]);
  });
});

describe('searchRowFingerprint', () => {
  it('berubah saat isi berubah, stabil saat sama', () => {
    const a = searchRowFingerprint({ content: 'ENC1:aaaa' });
    const b = searchRowFingerprint({ content: 'ENC1:aaaa' });
    const c = searchRowFingerprint({ content: 'ENC1:bbbb' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('membedakan tombstone / view-once tanpa dekripsi', () => {
    const plain = searchRowFingerprint({ content: 'ENC1:aaaa' });
    const tombstone = searchRowFingerprint({ content: 'ENC1:aaaa', isDeletedLocal: 'ENC1:dHJ1ZQ==' });
    const viewOnce = searchRowFingerprint({ content: 'ENC1:aaaa', isViewOnce: 'ENC1:dHJ1ZQ==' });
    expect(tombstone).not.toBe(plain);
    expect(viewOnce).not.toBe(plain);
  });
});

describe('MessageSearchIndex', () => {
  const texts: Record<string, string> = {
    m1: 'Hello world from Alice',
    m2: 'hello there, world traveler',
    m3: 'unrelated message',
    m4: 'WORLD only',
  };

  const build = () => {
    const index = new MessageSearchIndex();
    for (const [id, text] of Object.entries(texts)) index.add(id, 'c1', text);
    return index;
  };

  it('menemukan pesan dengan AND antar token (semua token harus ada)', () => {
    const index = build();
    expect(index.candidates('c1', 'hello world').sort()).toEqual(['m1', 'm2']);
    expect(index.candidates('c1', 'hello unrelated').sort()).toEqual([]);
  });

  it('tetap cocok untuk query yang memotong batas kata (semantik substring lama)', () => {
    const index = build();
    // "o wor" ada di "Hello world"; token querynya ('o', 'wor') bukan prefix dari
    // token teks mana pun secara utuh → pencocokan substring antar token, dan
    // hasil akhirnya dipersempit oleh verifikasi `includes` di store.
    for (const query of ['o wor', 'llo wo', 'LO WO']) {
      matchesSubstring(index, 'c1', query, texts);
      const verified = index
        .candidates('c1', query)
        .filter((id) => texts[id]!.toLowerCase().includes(query.toLowerCase()));
      expect(verified).toEqual(['m1']);
    }
  });

  it('tidak peka huruf besar/kecil', () => {
    const index = build();
    expect(index.candidates('c1', 'WoRlD').sort()).toEqual(['m1', 'm2', 'm4']);
  });

  it('tidak mencampur percakapan', () => {
    const index = new MessageSearchIndex();
    index.add('m1', 'c1', 'hello world');
    index.add('m2', 'c2', 'hello world');
    expect(index.candidates('c1', 'hello')).toEqual(['m1']);
    expect(index.candidates('c2', 'hello')).toEqual(['m2']);
  });

  it('menghapus pesan yang di-unsend/hilang dari indeks', () => {
    const index = build();
    index.remove('m1');
    expect(index.candidates('c1', 'alice')).toEqual([]);
    expect(index.candidates('c1', 'hello').sort()).toEqual(['m2']);
    expect(index.size).toBe(3);
  });

  it('idempoten saat pesan yang sama ditambahkan ulang', () => {
    const index = build();
    index.add('m1', 'c1', 'Hello world from Alice');
    expect(index.size).toBe(4);
  });

  it('menghormati limit kandidat untuk query sangat umum', () => {
    const index = build();
    expect(index.candidates('c1', 'e', 2)).toHaveLength(2);
  });

  it('menghasilkan kandidat urut sesuai urutan indeks (lama→baru)', () => {
    const index = build();
    expect(index.candidates('c1', 'world')).toEqual(['m1', 'm2', 'm4']);
  });

  it('membuang percakapan paling lama saat lewat batas memori', () => {
    const index = new MessageSearchIndex({ maxMessages: 3 });
    index.add('a1', 'c1', 'alpha one');
    index.add('a2', 'c1', 'alpha two');
    index.add('b1', 'c2', 'beta one');
    expect(index.size).toBe(3);

    // c1 dipakai lagi → c2 jadi paling lama tidak dipakai; satu pesan baru
    // (percakapan c3) melewati batas dan memaksa eviksi c2.
    index.candidates('c1', 'alpha');
    index.add('c1x', 'c3', 'gamma one');

    expect(index.candidates('c2', 'beta')).toEqual([]); // c2 dibuang
    expect(index.candidates('c1', 'alpha').sort()).toEqual(['a1', 'a2']);
    expect(index.size).toBeLessThanOrEqual(3);
  });

  it('clear mengosongkan seluruh indeks', () => {
    const index = build();
    index.clear();
    expect(index.size).toBe(0);
    expect(index.conversationCount).toBe(0);
    expect(index.candidates('c1', 'hello')).toEqual([]);
  });

  it('batas produksi tetap sama dengan konstanta yang didokumentasikan', () => {
    expect(SEARCH_INDEX_MAX_MESSAGES).toBe(20_000);
  });
});
