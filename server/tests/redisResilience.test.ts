// Test ketahanan Redis — tanpa Redis/Postgres nyata (konvensi repo: fake client).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCheckRateLimit,
  invalidateActiveDeviceCache,
  RATE_LIMIT_LUA,
  DEVICE_CACHE_INVALIDATE_CHANNEL,
  type EvalLikeClient,
  type PublishLikeClient,
} from '../src/utils/redisResilience.js';
// [docs/28 Tier 1.5 / D14] key rate-limit memakai tag identitas, bukan userId asli.
import { identityTag } from '../src/utils/redisIdentity.js';

describe('checkRateLimit (fail-open saat Redis bermasalah)', () => {
  test('mengizinkan ketika hitungan <= limit', async () => {
    let n = 0;
    const client: EvalLikeClient = {
      eval: async () => ++n, // 1, 2, 3, ...
    };
    const check = createCheckRateLimit(client);
    assert.equal(await check('u1', 'chat_message', 3, 60), true);  // 1
    assert.equal(await check('u1', 'chat_message', 3, 60), true);  // 2
    assert.equal(await check('u1', 'chat_message', 3, 60), true);  // 3
    assert.equal(await check('u1', 'chat_message', 3, 60), false); // 4 > 3
  });

  test('Redis down (eval melempar) → FAIL-OPEN, tidak melempar', async () => {
    const client: EvalLikeClient = {
      eval: async () => { throw new Error('Connection is closed'); },
    };
    const check = createCheckRateLimit(client);
    await assert.doesNotReject(() => check('u2', 'chat_message', 1, 60));
    assert.equal(await check('u2', 'chat_message', 1, 60), true);
  });

  test('balasan tidak masuk akal (NaN / negatif) → fail-open', async () => {
    const check = createCheckRateLimit({ eval: async () => 'bukan-angka' } as EvalLikeClient);
    assert.equal(await check('u3', 'x', 1, 60), true);
    const checkNeg = createCheckRateLimit({ eval: async () => -5 } as EvalLikeClient);
    assert.equal(await checkNeg('u3', 'x', 1, 60), true);
  });

  test('argumen eval: key + window dikirim dengan benar', async () => {
    let captured: { keys: string[]; arguments: string[] } | null = null;
    const client: EvalLikeClient = {
      eval: async (_script, opts) => { captured = opts; return 1; },
    };
    await createCheckRateLimit(client)('u4', 'presence_update', 30, 45);
    assert.ok(captured);
    // [docs/28 Tier 1.5 / D14] sufiks key adalah HMAC(pepper, 'redis:v1:u4'),
    // BUKAN userId asli — dump Redis tidak bisa memetakan key ke user.
    assert.deepEqual(captured!.keys, [`rate_limit:socket:${identityTag('u4')}:presence_update`]);
    assert.ok(
      !captured!.keys[0]!.includes('u4'),
      'regresi D14: userId asli muncul di nama key Redis'
    );
    assert.deepEqual(captured!.arguments, ['45']);
  });

  test('skrip Lua TETAP pola atomic INCR+EXPIRE (regresi AGENTS)', () => {
    assert.match(RATE_LIMIT_LUA, /redis\.call\('INCR'/);
    assert.match(RATE_LIMIT_LUA, /redis\.call\('EXPIRE'/);
    // EXPIRE harus berada di dalam `if current == 1` — bukan setelahnya.
    const expirePos = RATE_LIMIT_LUA.indexOf("redis.call('EXPIRE'");
    const incrIf = RATE_LIMIT_LUA.indexOf("if current == 1 then");
    const endifPos = RATE_LIMIT_LUA.indexOf('end', incrIf);
    assert.ok(expirePos > incrIf && expirePos < endifPos, 'EXPIRE harus di dalam if current == 1');
  });
});

describe('invalidateActiveDeviceCache (best-effort)', () => {
  test('publish JSON {userId} ke channel khusus', async () => {
    const calls: Array<{ channel: string; message: string }> = [];
    const publisher: PublishLikeClient = {
      publish: async (channel, message) => { calls.push({ channel, message }); },
    };
    await invalidateActiveDeviceCache('user-9', publisher);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.channel, DEVICE_CACHE_INVALIDATE_CHANNEL);
    assert.deepEqual(JSON.parse(calls[0]!.message), { userId: 'user-9' });
  });

  test('publish gagal → tidak melempar (best-effort)', async () => {
    const publisher: PublishLikeClient = {
      publish: async () => { throw new Error('Redis down'); },
    };
    await assert.doesNotReject(() => invalidateActiveDeviceCache('user-9', publisher));
  });
});
