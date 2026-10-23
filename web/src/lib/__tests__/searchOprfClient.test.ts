import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_OPRF_SUITE,
  blindSearchIdentifier,
  deriveSearchOprfServerKeys,
  evaluateSearchOprfBlinded,
  finalizeSearchOprfIndex,
} from '@nyx/shared';
import { api } from '../api';
import { oprfSearchEnabled, oprfSearchIndex } from '../searchOprfClient';

vi.mock('../api', () => ({ api: vi.fn() }));

const mockedApi = vi.mocked(api);
const raw = new Uint8Array(32).fill(5);

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const rawB64 = toBase64Url(raw);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('searchOprfClient', () => {
  it('gate hanya menerima 1/true', () => {
    vi.stubEnv('VITE_PIR_OPRF_ENABLED', '1');
    expect(oprfSearchEnabled()).toBe(true);
    vi.stubEnv('VITE_PIR_OPRF_ENABLED', 'true');
    expect(oprfSearchEnabled()).toBe(true);
    vi.stubEnv('VITE_PIR_OPRF_ENABLED', 'on');
    expect(oprfSearchEnabled()).toBe(false);
  });

  it('blind -> server evaluate -> finalize menghasilkan index yang sama', async () => {
    const keys = deriveSearchOprfServerKeys(new Uint8Array(32).fill(1));
    mockedApi.mockImplementation(async (_path, options) => {
      const body = JSON.parse(String(options?.body)) as { blinded: string };
      const evaluated = evaluateSearchOprfBlinded(
        keys.secretKey,
        fromBase64Url(body.blinded),
      );
      return { suite: SEARCH_OPRF_SUITE, evaluated: toBase64Url(evaluated) };
    });

    const client = blindSearchIdentifier(raw);
    const expected = finalizeSearchOprfIndex(
      client.input,
      client.blind,
      evaluateSearchOprfBlinded(keys.secretKey, client.blinded),
    );

    await expect(oprfSearchIndex(rawB64)).resolves.toBe(expected);
    expect(mockedApi).toHaveBeenCalledWith('/api/users/search/oprf', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('gagal server tidak fallback', async () => {
    mockedApi.mockRejectedValue(new Error('PIR_OPRF_DISABLED'));
    await expect(oprfSearchIndex(rawB64)).rejects.toThrow('PIR_OPRF_DISABLED');
  });

  it('menolak identifier bukan 32 byte', async () => {
    await expect(oprfSearchIndex(toBase64Url(new Uint8Array([1, 2])))).rejects.toThrow();
  });
});
