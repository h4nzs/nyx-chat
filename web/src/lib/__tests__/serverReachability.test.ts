import { describe, it, expect } from 'vitest';
import { ApiError } from '../api';
import { isServerUnreachable } from '../serverReachability';

describe('isServerUnreachable', () => {
  it.each([0, 502, 503, 504, 520, 522, 530])('ApiError %i → true', (status) => {
    expect(isServerUnreachable(new ApiError(status, 'x'))).toBe(true);
  });

  it.each([200, 400, 401, 403, 404, 426, 429, 500, 501, 505, 519, 531])('ApiError %i → false', (status) => {
    expect(isServerUnreachable(new ApiError(status, 'x'))).toBe(false);
  });

  it('TypeError (fetch gagal di jaringan) → true', () => {
    expect(isServerUnreachable(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('abort dari pemanggil & error lain → false', () => {
    expect(isServerUnreachable(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isServerUnreachable(new Error('boom'))).toBe(false);
    expect(isServerUnreachable(undefined)).toBe(false);
  });
});
