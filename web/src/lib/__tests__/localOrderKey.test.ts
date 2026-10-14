/**
 * [docs/30 WS-F] Unit test skema urutan terenkripsi lokal.
 *
 * Crypto at-rest di-stub (pola repo: tidak butuh masterSeed/Postgres/Redis) —
 * yang diuji adalah logika murni: bucket plaintext, rantai fallback saat
 * membaca, dan pemangkasan halaman pada batas bucket.
 */
import { describe, it, expect, vi } from 'vitest';

// Stub lapis at-rest: envelope `ENC1:` + base64 angka (mirror bentuk nyata).
vi.mock('../localAtRest', () => ({
  LOCAL_TIME_BUCKET_MS: 15 * 60 * 1000,
  sealLocalNumber: vi.fn(async (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value)
      ? 'ENC1:' + Buffer.from(String(value), 'utf8').toString('base64')
      : null
  ),
  openLocalNumber: vi.fn(async (raw: number | string | null | undefined) => {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (!raw.startsWith('ENC1:')) return null;
    const payload = Buffer.from(raw.slice(5), 'base64').toString('utf8');
    // Dekripsi gagal/kosong → null (mirror `openLocalNumber` nyata, bukan 0).
    if (payload.length === 0) return null;
    const parsed = Number(payload);
    return Number.isFinite(parsed) ? parsed : null;
  }),
}));

import {
  ensureOrderFields,
  hasIndexableOrder,
  LOCAL_TIME_BUCKET_MS,
  openOrderInstant,
  orderBucketOf,
  pickOlderPage,
  previousOrderBucket,
  resolveOrderInstants,
  sealOrderFields,
  type SealedOrderRow,
} from '../localOrderKey';

const MIN = 60 * 1000;
const BUCKET = LOCAL_TIME_BUCKET_MS;
/** Awal sebuah bucket, supaya aritmetika test eksplisit. */
const B0 = Math.floor(Date.now() / BUCKET) * BUCKET - 10 * BUCKET;

describe('orderBucketOf', () => {
  it('memotong waktu ke bucket 15 menit (floor) dan menerima ISO/Date/number', () => {
    const ms = B0 + 7 * MIN + 123;
    expect(orderBucketOf(ms)).toBe(B0);
    expect(orderBucketOf(new Date(ms))).toBe(B0);
    expect(orderBucketOf(new Date(ms).toISOString())).toBe(B0);
    // Baris tepat di batas bucket tetap di bucket itu (floor, bukan ceil).
    expect(orderBucketOf(B0)).toBe(B0);
    expect(orderBucketOf(B0 - 1)).toBe(B0 - BUCKET);
  });

  it('mengembalikan null untuk nilai tak valid', () => {
    expect(orderBucketOf(null)).toBeNull();
    expect(orderBucketOf(undefined)).toBeNull();
    expect(orderBucketOf('')).toBeNull();
    expect(orderBucketOf('bukan-tanggal')).toBeNull();
    expect(orderBucketOf(Number.NaN)).toBeNull();
  });
});

describe('sealOrderFields / openOrderInstant', () => {
  it('menulis dua lapis: bucket plaintext + instant presisi ter-seal', async () => {
    const ms = B0 + 3 * MIN;
    const fields = await sealOrderFields(ms);
    expect(fields.orderBucketMs).toBe(B0);
    expect(fields.createdAtSealed).toMatch(/^ENC1:/);
    // Ciphertext tidak boleh memuat waktu plaintext apa pun.
    expect(fields.createdAtSealed).not.toContain(String(ms));
  });

  it('null/tak valid ditulis sebagai null di kedua lapis', async () => {
    await expect(sealOrderFields(null)).resolves.toEqual({ orderBucketMs: null, createdAtSealed: null });
    await expect(sealOrderFields(undefined)).resolves.toEqual({ orderBucketMs: null, createdAtSealed: null });
  });

  it('membaca presisi: lapis seal menang, lalu ISO lama, terakhir bucket', async () => {
    const precise = B0 + 5 * MIN;
    const sealed = await sealOrderFields(precise);

    // Baris baru: presisi dari envelope.
    await expect(openOrderInstant(sealed)).resolves.toBe(precise);

    // Baris lama (belum di-upgrade): ISO plaintext.
    await expect(openOrderInstant({ createdAt: new Date(precise).toISOString() })).resolves.toBe(precise);

    // Baris lama yang hanya punya bucket → jatuh ke bucket (kasar).
    await expect(openOrderInstant({ orderBucketMs: B0 })).resolves.toBe(B0);

    // Envelope rusak/kosong → jatuh ke bentuk lama, bukan null.
    await expect(
      openOrderInstant({ createdAtSealed: 'ENC1:!!!', createdAt: new Date(precise).toISOString() })
    ).resolves.toBe(precise);

    // Tidak ada informasi waktu sama sekali.
    await expect(openOrderInstant({})).resolves.toBeNull();
    await expect(openOrderInstant({ createdAt: 'bukan-tanggal' })).resolves.toBeNull();
  });

  it('resolveOrderInstants sejajar indeks dengan baris', async () => {
    const ms = B0 + MIN;
    const rows: SealedOrderRow[] = [{ orderBucketMs: B0 }, { createdAt: new Date(ms).toISOString() }, {}];
    await expect(resolveOrderInstants(rows)).resolves.toEqual([B0, ms, null]);
  });
});

describe('pickOlderPage', () => {
  /** Kandidat seperti hasil indeks bucket: apa pun urutannya, presisi ter-seal. */
  async function candidates(offsetsMinutes: number[], base = B0): Promise<SealedOrderRow[]> {
    const rows: SealedOrderRow[] = [];
    for (const off of offsetsMinutes) rows.push(await sealOrderFields(base + off * MIN));
    return rows;
  }

  it('mempertahankan semantik lama: kursor inklusif, maksimal limit, urut lama→baru', async () => {
    const rows = await candidates([0, 1, 2, 3, 4]);
    const instants = await resolveOrderInstants(rows);
    const before = B0 + 3 * MIN;

    const { page } = pickOlderPage(rows, instants, 2, before);
    // Diambil dari ujung TERBARU rentang yang memenuhi `<= before`, lalu
    // dikembalikan lama→baru (sama seperti `.reverse().limit().reverse()`).
    expect(page).toHaveLength(2);
    expect(page.map((r) => r.createdAtSealed && openOrderInstant(r))).toHaveLength(2);
    const pageInstants = await resolveOrderInstants(page);
    expect(pageInstants).toEqual([B0 + 2 * MIN, B0 + 3 * MIN]);

    // `before` inklusif: baris tepat di kursor ikut masuk.
    const inclusive = pickOlderPage(rows, instants, 10, B0 + 3 * MIN);
    await expect(resolveOrderInstants(inclusive.page)).resolves.toEqual([
      B0,
      B0 + MIN,
      B0 + 2 * MIN,
      B0 + 3 * MIN,
    ]);
  });

  it('mengembalikan kursor halaman (bucket + presisi baris terlama)', async () => {
    const rows = await candidates([0, 1]);
    const instants = await resolveOrderInstants(rows);
    const { page, boundaryBucketMs, boundaryInstantMs } = pickOlderPage(rows, instants, 2);
    expect(page).toHaveLength(2);
    expect(boundaryBucketMs).toBe(B0);
    expect(boundaryInstantMs).toBe(B0);
    // Kursor bucket dipakai penyedia data untuk meminta bucket yang lebih lama.
    expect(orderBucketOf(boundaryInstantMs)).toBe(boundaryBucketMs);
  });

  it('tanpa kursor: halaman = limit pesan terbaru, urut lama→baru', async () => {
    const rows = await candidates([0, 1, 2, 3]);
    const instants = await resolveOrderInstants(rows);
    const { page } = pickOlderPage(rows, instants, 2);
    await expect(resolveOrderInstants(page)).resolves.toEqual([B0 + 2 * MIN, B0 + 3 * MIN]);
  });

  it('membuang baris tanpa waktu (tidak pernah cocok dengan range indeks)', async () => {
    const rows = await candidates([0, 1]);
    const instants = await resolveOrderInstants([...rows, {}]);
    const { page } = pickOlderPage([...rows, {}], instants, 10);
    expect(page).toHaveLength(2);
  });

  it('limit 0 → halaman kosong tanpa kursor', async () => {
    const rows = await candidates([0, 1]);
    const instants = await resolveOrderInstants(rows);
    expect(pickOlderPage(rows, instants, 0)).toEqual({ page: [], boundaryBucketMs: null, boundaryInstantMs: null });
  });
});

describe('previousOrderBucket', () => {
  it('mundur tepat satu bucket (langkah pembaca indeks)', () => {
    expect(previousOrderBucket(B0)).toBe(B0 - BUCKET);
    expect(previousOrderBucket(B0 - 5 * BUCKET)).toBe(B0 - 6 * BUCKET);
  });
});

describe('ensureOrderFields', () => {
  it('baris baru: bucket diisi, presisi masuk lapisan ter-seal, plaintext dilepas', async () => {
    const ms = B0 + 2 * MIN;
    const row = await ensureOrderFields({ createdAt: new Date(ms).toISOString() });
    expect(row.orderBucketMs).toBe(B0);
    expect(row.createdAtSealed).toMatch(/^ENC1:/);
    expect(row.createdAt).toBeNull();
    expect(hasIndexableOrder(row)).toBe(true);
    await expect(openOrderInstant(row)).resolves.toBe(ms);
  });

  it('idempoten: baris yang sudah ter-seal tidak ditulis ulang', async () => {
    const sealed = await sealOrderFields(B0 + MIN);
    const once = await ensureOrderFields({ ...sealed, createdAt: null });
    const twice = await ensureOrderFields(once);
    expect(twice.createdAtSealed).toBe(once.createdAtSealed);
    expect(twice.orderBucketMs).toBe(B0);
  });

  it('baris lama tanpa lapis presisi tetap dapat bucket (bisa diindeks)', async () => {
    const row = await ensureOrderFields({ createdAt: null, orderBucketMs: B0 });
    expect(row.orderBucketMs).toBe(B0);
    expect(hasIndexableOrder(row)).toBe(true);
  });

  it('baris tanpa informasi waktu sama sekali → bucket null, tetap tidak crash', async () => {
    const row = await ensureOrderFields({});
    expect(row.orderBucketMs).toBeNull();
    expect(hasIndexableOrder(row)).toBe(false);
  });

  it('gagal seal (vault terkunci) → plaintext TIDAK dihapus', async () => {
    const { sealLocalNumber } = await import('../localAtRest');
    const ms = B0 + 3 * MIN;
    vi.mocked(sealLocalNumber).mockResolvedValueOnce(null);
    const row = await ensureOrderFields({ createdAt: new Date(ms).toISOString() });
    // Plaintext dipertahankan justru supaya waktunya tidak hilang;
    // bucket tetap terisi sehingga baris tetap muncul di query.
    expect(row.createdAtSealed).toBeUndefined();
    expect(row.createdAt).toBe(new Date(ms).toISOString());
    expect(row.orderBucketMs).toBe(B0);
  });
});

describe('integrasi penyedia data (simulasi, tanpa IndexedDB)', () => {
  it('halaman fetch-older tidak melewatkan baris di dalam bucket batas', async () => {
    // 4 pesan dalam SATU bucket; cursor di tengah; limit 2.
    const all = await Promise.all([0, 4, 4.5, 10].map((off) => sealOrderFields(B0 + off * MIN)));
    const instants = await resolveOrderInstants(all);
    const byInstant = new Map(all.map((row, i) => [instants[i] as number, row]));

    // Kursor = pesan ke-3 secara kronologis (B0 + 4.5 menit).
    const cursor = B0 + 4.5 * MIN;

    // Penyedia data meniru pembaca indeks: ambil bucket UTUH (`.equals([conv, b])`),
    // mundur satu bucket selama halaman belum penuh.
    const fetched: SealedOrderRow[] = [];
    let fetchedInstants: (number | null)[] = [];
    for (let bucket: number | null = orderBucketOf(cursor); bucket !== null; bucket = previousOrderBucket(bucket)) {
      const inBucket = [...byInstant].filter(([instant]) => orderBucketOf(instant) === bucket);
      if (inBucket.length === 0) continue;
      for (const [instant, row] of inBucket) {
        fetched.push(row);
        fetchedInstants.push(instant);
      }
      if (fetched.length >= 2) break;
    }
    expect(fetched).toHaveLength(4); // seluruh bucket terambil, bukan hanya 2 baris

    const { page } = pickOlderPage(fetched, fetchedInstants, 2, cursor);
    // Dua pesan TERBARU yang ≤ kursor (bukan dua yang kebetulan terambil dulu).
    await expect(resolveOrderInstants(page)).resolves.toEqual([B0 + 4 * MIN, B0 + 4.5 * MIN]);
  });

  it('halaman berikutnya melanjutkan dari kursor presisi (baris batas tetap inklusif)', async () => {
    const all = await Promise.all([0, 4, 4.5, 10].map((off) => sealOrderFields(B0 + off * MIN)));
    const instants = await resolveOrderInstants(all);
    const first = pickOlderPage(all, instants, 2, B0 + 4.5 * MIN);
    expect(first.boundaryInstantMs).toBe(B0 + 4 * MIN);

    const second = pickOlderPage(all, instants, 2, first.boundaryInstantMs);
    const secondInstants = await resolveOrderInstants(second.page);
    // Kursor inklusif = perilaku lama: baris batas muncul lagi di halaman
    // berikutnya (store menggabung berdasarkan id), bukan ada yang terlewat.
    expect(secondInstants).toEqual([B0, B0 + 4 * MIN]);
    expect(second.boundaryInstantMs).toBe(B0);
  });
});
