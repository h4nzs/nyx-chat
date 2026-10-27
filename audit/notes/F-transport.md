# F — Transport & relay (WebTransport ↔ WebSocket)

Diperiksa: `server/transport-sidecar/src/{main,protocol,metrics}.rs`,
`server/src/network/redisBridge.ts`, `server/src/realtime/gateway.ts`,
`server/src/network/realtimeHandlers.ts`, `server/src/utils/
transportCapability.ts`, `packages/shared/src/transport.ts`,
`web/src/lib/transportClient.ts`, `web/src/workers/transport.worker.ts`,
`docs/08`, `docs/18`, `server/tests/gatewayParity.test.ts`.

## Empat lubang paritas (commit `b901bef`) — status

1. **Rate limit jalur data** kini di handler, bukan gateway: satu bucket
   `(user, event)` dipakai kedua transport (`realtimeHandlers.ts`
   `CHAT_RATE_LIMIT/ACK_RATE_LIMIT/PRESENCE_RATE_LIMIT`), dan
   `gatewayParity.test.ts:226` menegakkannya. **Tertutup.**
2. **Kapabilitas** dinegosiasikan di dua relay dari satu sumber:
   `SERVER_CAPABILITIES` di `packages/shared/src/transport.ts:67` (terverifikasi),
   diiris dengan kapabilitas klien di gateway dan HELLO sidecar. **Tertutup.**
3. **KEY_SYNC events** didaftarkan lewat satu daftar (`WSS_KEYS_SYNC_EVENTS`),
   dengan test yang memastikan setiap event punya `case`. **Tertutup.**
4. **KICK/force_logout** dikirim sebelum socket ditutup, dengan nama event yang
   sama di kedua jalur. **Tertutup.**

Tidak saya temukan lubang kelima pada jalur yang sama; sinkronisasi opcode
Rust↔TS masih manual (angka hardcoded di `main.rs` vs
`packages/shared/src/transport.ts`) dan tidak ada test yang membandingkannya —
pengamatan, bukan bug saat ini.

## Positif lain

- **Sidecar fail-closed untuk `JWT_SECRET`** — terverifikasi ulang:
  `main.rs:180-181` melempar bila env tidak ada (tidak ada nilai cadangan).
- Batas ukuran frame, klasifikasi frame, dan parse HELLO berada di
  `protocol.rs` (bisa di-fuzz), bukan inline di loop koneksi.
- Limit Redis memakai Lua atomik (`RATE_LIMIT_LUA`), bukan INCR lalu EXPIRE.

## Temuan terkait

- **F-06** — `OHTTP_TOKEN_MODE=off` membuat `internalToken` acak **per proses**
  (`ohttp/config.ts:139`) sementara `/relay` memanggil gateway lewat HTTP
  loopback (`routes/ohttp.ts:98`); dengan pm2 `-i max` request bisa mendarat di
  worker lain → 403 acak. `ohttp/relay.ts:43` menolak relay proses terpisah,
  jadi mode ini hanya benar untuk satu proses.
- **F-12** — `cargo clippy -D warnings` merah (3 lint) dan tidak ada di CI.
- **D5** — konstruksi frame KICK diduplikasi di dua cabang `main.rs` (kelas
  duplikasi yang seharusnya dicegah oleh `protocol.rs`).

## Batas

E2E `transport.spec`/`chat.spec` tidak dijalankan (butuh sidecar + Chrome penuh);
fuzz 1 jam tidak dijalankan; tidak ada uji beban DoS/slowloris.
