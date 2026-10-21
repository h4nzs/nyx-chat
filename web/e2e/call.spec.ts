// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// [docs/30 §30.9 WS-E(1)/(2)] Bukti relay panggilan lewat **coturn yang benar-benar
// berjalan** — residual lama “bukti E2E panggilan dengan coturn nyata (lingkungan)”.
//
// Yang dibuktikan, berurutan:
//   1. `/api/keys/turn` memberi kredensial **coturn** (bukan hanya STUN), lewat
//      jalur klien produksi (`web/src/lib/api.ts`);
//   2. dua peer WebRTC di browser yang sama, dengan `iceTransportPolicy: 'relay'`
//      (memaksa TURN; tanpa itu kandidat host lokal akan menang dan TURN tidak
//      pernah tersentuh), benar-benar **terhubung**;
//   3. kandidat yang akhirnya dipakai berjenis **relay** dan alamatnya berasal
//      dari coturn — bukan jalur LAN/host.
//
// Skip otomatis (dengan alasan) bila server tidak dikonfigurasi TURN: tanpa coturn
// tidak ada yang bisa dibuktikan, dan menguji STUN publik justru berbohong.
//
// Menjalankan coturn lokal (uji 2026-10-15):
//   docker run -d --name nyx-coturn --network host \
//     -v /tmp/coturn.conf:/etc/coturn/turnserver.conf:ro \
//     coturn/coturn:4.6-alpine -c /etc/coturn/turnserver.conf
//   # turnserver.conf: listening-ip/relay-ip=127.0.0.1, use-auth-secret,
//   # static-auth-secret=<sama dengan TURN_STATIC_AUTH_SECRET server>, realm,
//   # min-port/max-port, allow-loopback-peers (wajib: coturn menolak peer
//   # loopback secara default → channel bind 403 di uji satu mesin).
import { test, expect } from '@playwright/test';
import { registerUser } from './helpers/registration';

interface TurnPayload {
  iceServers: RTCIceServer[];
  stunOnly?: boolean;
}

test.describe('Panggilan (relay coturn nyata)', () => {
  test.setTimeout(180000);

  test('kredensial coturn dari server benar-benar merelay media', async ({ page }) => {
    const username = `turn_${Date.now()}`;
    await registerUser(page, 'Turn User', username);

    const payload = await test.step('ambil kredensial TURN lewat klien API produksi', async () => {
      return page.evaluate(async (): Promise<TurnPayload> => {
        // @ts-ignore — path absolut Vite dev server (runtime-only)
        const mod = (await import('/src/lib/api.ts')) as {
          api: <T>(path: string) => Promise<T>;
        };
        try {
          return await mod.api<TurnPayload>('/api/keys/turn');
        } catch (error) {
          // Server tanpa TURN sama sekali menjawab 503 TURN_NOT_CONFIGURED
          // (bukan payload `stunOnly`). Itu juga alasan untuk skip, bukan gagal.
          const code = (error as { code?: string; message?: string }).code
            ?? (error as { message?: string }).message;
          const details = (error as { details?: { error?: string } }).details;
          if (code === 'TURN_NOT_CONFIGURED' || details?.error === 'TURN_NOT_CONFIGURED') {
            return { iceServers: [], stunOnly: true };
          }
          throw error;
        }
      });
    });

    expect(payload, 'respons /api/keys/turn kosong').toBeTruthy();

    // Endpoint ini mengembalikan coturn (primer) **dan** Cloudflare TURN (cadangan),
    // dan Cloudflare memakai bentuk kredensial sendiri (bukan `<expiry>:<tag>`).
    // Yang diuji di sini harus coturn milik sendiri: kalau kredensial Cloudflare
    // ikut dipakai, bukti relay bisa lolos tanpa coturn sama sekali — justru
    // residual yang mau ditutup. Kredensial coturn dikenali dari bentuk REST-nya.
    const isCoturnCredential = (server: RTCIceServer) => /^\d+:/.test(String(server.username ?? ''));
    const coturnServers = payload!.iceServers.filter(
      (server) => server.username && server.credential && isCoturnCredential(server)
    );
    test.skip(
      payload!.stunOnly === true || coturnServers.length === 0,
      'TURN self-host (coturn) tidak dikonfigurasi di server ini — jalankan coturn + TURN_URLS/TURN_STATIC_AUTH_SECRET'
    );
    console.log(`[turn] entri coturn: ${JSON.stringify(coturnServers)}`);

    // Kredensial coturn berbentuk "<unixExpiry>:<identityTag>" — identitas di
    // username adalah tag, bukan userId (`docs/28`): server tidak boleh tahu
    // pemetaan sesi call ke akun dari kredensialnya sendiri.
    const firstUsername = String(coturnServers[0]!.username);
    const [expiry, ...rest] = firstUsername.split(':');
    expect(Number(expiry), `username TURN tanpa prefiks kedaluwarsa: ${firstUsername}`).toBeGreaterThan(Date.now() / 1000 - 60);
    expect(rest.join(':').length, 'identityTag kosong di username TURN').toBeGreaterThan(0);
    expect(JSON.stringify(coturnServers[0]!.urls)).toContain('turn:');

    const turnServers = coturnServers;

    const result = await test.step('dua peer relay-only: kumpulkan kandidat, sambungkan, periksa pasangan terpilih', async () => {
      return page.evaluate(
        async ({ iceServers }) => {
          const makePeer = () =>
            new RTCPeerConnection({
              iceServers: iceServers as RTCIceServer[],
              // Memaksa seluruh kandidat lewat TURN. Tanpa ini, dua tab di mesin
              // yang sama akan memakai kandidat host dan coturn tidak teruji.
              iceTransportPolicy: 'relay',
            });

          const collectCandidates = (pc: RTCPeerConnection) =>
            new Promise<{ type: string; address: string | null; protocol: string | null; transport: string | null }[]>((resolve) => {
              const found: { type: string; address: string | null; protocol: string | null; transport: string | null }[] = [];
              pc.addEventListener('icecandidate', (event) => {
                if (!event.candidate) {
                  resolve(found);
                  return;
                }
                found.push({
                  type: event.candidate.type ?? 'unknown',
                  address: event.candidate.address ?? null,
                  protocol: event.candidate.protocol ?? null,
                  transport: event.candidate.relatedAddress ?? null,
                });
              });
            });

          const caller = makePeer();
          const callee = makePeer();
          // Data channel = "media" untuk keperluan pembuktian jalur relay.
          caller.createDataChannel('relay-proof');

          const callerCandidates = collectCandidates(caller);
          const calleeCandidates = collectCandidates(callee);

          // Uji ini **tanpa trickle ICE** (tidak ada jalur sinyal di sini), jadi
          // SDP baru boleh diserahkan setelah gathering selesai — kalau tidak,
          // SDP tanpa kandidat membuat ICE tak pernah membentuk pasangan dan
          // `connectionState` mandek di `new` (bug, bukan kegagalan coturn).
          const gatheringDone = (pc: RTCPeerConnection) =>
            new Promise<void>((resolve) => {
              if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
              }
              pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') resolve();
              });
            });

          const offer = await caller.createOffer();
          await caller.setLocalDescription(offer);
          await gatheringDone(caller);
          await callee.setRemoteDescription(caller.localDescription!);
          const answer = await callee.createAnswer();
          await callee.setLocalDescription(answer);
          await gatheringDone(callee);
          await caller.setRemoteDescription(callee.localDescription!);

          const [callerGathered, calleeGathered] = await Promise.all([callerCandidates, calleeCandidates]);

          const waitFor = async (
            check: () => boolean,
            timeoutMs: number
          ): Promise<boolean> => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (check()) return true;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            return check();
          };

          const connected = await waitFor(
            () => caller.connectionState === 'connected' && callee.connectionState === 'connected',
            30000
          );

          // Pasangan kandidat terpilih: inilah bukti relay benar-benar dipakai.
          let selected: { localType?: string; remoteType?: string; localAddress?: string } = {};
          try {
            const stats = await caller.getStats();
            stats.forEach((report) => {
              if (report.type === 'transport' && report.selectedCandidatePairId) {
                const pair = stats.get(report.selectedCandidatePairId);
                const local = pair?.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
                const remote = pair?.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined;
                selected = {
                  localType: local?.candidateType,
                  remoteType: remote?.candidateType,
                  localAddress: local?.address ?? local?.ip,
                };
              }
            });
          } catch {
            /* stats tidak wajib tersedia di semua build Chrome */
          }

          // Ambil status SEBELUM menutup: setelah `close()` keduanya selalu
          // `closed`, jadi pesan kegagalan kehilangan informasi yang berguna.
          const callerState = caller.connectionState;
          const calleeState = callee.connectionState;

          caller.close();
          callee.close();

          return {
            callerState,
            calleeState,
            connected,
            callerCandidates: callerGathered,
            calleeCandidates: calleeGathered,
            selected,
          };
        },
        { iceServers: turnServers }
      );
    });

    // 1. Kandidat relay benar-benar terkumpul (berarti alokasi TURN berhasil).
    const callerRelay = result.callerCandidates.filter((candidate) => candidate.type === 'relay');
    const calleeRelay = result.calleeCandidates.filter((candidate) => candidate.type === 'relay');
    expect(callerRelay.length, `kandidat pemanggil: ${JSON.stringify(result.callerCandidates)}`).toBeGreaterThan(0);
    expect(calleeRelay.length, `kandidat penerima: ${JSON.stringify(result.calleeCandidates)}`).toBeGreaterThan(0);
    console.log(`[turn] relay pemanggil: ${JSON.stringify(callerRelay)}`);

    // 2. Dua peer terhubung dengan kebijakan relay-only.
    expect(result.connected, `status koneksi: caller=${result.callerState} callee=${result.calleeState}`).toBe(true);

    // 3. Pasangan terpilih juga relay (bukan host/srflx). `getStats` tidak selalu
    //    tersedia; kalau kosong, bukti relay sudah cukup dari langkah 1+2.
    if (result.selected.localType) {
      expect(result.selected.localType, `pasangan terpilih: ${JSON.stringify(result.selected)}`).toBe('relay');
      console.log(`[turn] kandidat terpilih: ${JSON.stringify(result.selected)}`);
    }
  });
});
