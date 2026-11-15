# Pass 4 — Verifikasi fokus: transport & sidecar Rust

Lapisan ini **tidak pernah dibaca** pada pass 1–3 (ketiganya menyatakan begitu di
`00-scope.md` masing-masing). Yang diperiksa: `server/transport-sidecar/src/protocol.rs`
(502 baris, termasuk seluruh tes) dan `src/main.rs` pada jalur auth (tiket + BWH),
bidi, uni, datagram, sesi, serta konfigurasi QUIC/sertifikat. Yang **tidak**
diperiksa: `metrics.rs` (976 baris) secara rinci, `fuzz.rs` (kampanye tidak
dijalankan), dan `packages/spqr-wasm`.

## 1. Autentikasi — OK

- **Secret wajib, tanpa cadangan.** `JWT_SECRET` dibaca dengan `.context(...)`
  sehingga sidecar menolak boot bila kosong (`main.rs:120-122`). Komentar
  menyebut insiden lama (cadangan literal `"secret"`) — sudah tidak ada.
- **Algoritma dipin ke HS256** di kedua jalur, bukan `Validation::default()`
  (`main.rs:485-487` tiket, `:603-605` BWH). Ini menutup `alg: none` dan
  algorithm-confusion.
- **`exp` wajib** (`validate_exp = true` + `required_spec_claims.insert("exp")`,
  baris yang sama). Token tanpa `exp` ditolak, bukan diterima selamanya.
- **Panjang token dibatasi sebelum alokasi** (`auth_length > 4096` → tolak,
  `main.rs:583-588`), jadi header 5-byte tidak bisa memaksa alokasi besar.
- **UTF-8 rusak tidak meloloskan auth:** `String::from_utf8(...).unwrap_or_default()`
  → string kosong → `decode` gagal → `Unauthorized` (`main.rs:602-620`).
- **Identitas wajib ada:** `id` atau `sub`; tanpa keduanya → tolak
  (`main.rs:621-627`).

## 2. Satu perangkat aktif — OK (dengan catatan yang tidak diverifikasi)

Setelah auth, semua sesi ber-prefix `"<user_id>:"` dikeluarkan dari map dan
koneksinya ditutup `Logged in on another device`, lalu sesi baru dimasukkan
(`main.rs:641-679`). Ini konsisten dengan kebijakan single-active-device di sisi
Node (`isActiveDeviceAllowed`).

**Tidak diverifikasi:** dua koneksi bersamaan untuk user yang sama. Iterasi
`DashMap` + `insert` tidak atomik, jadi secara teori keduanya bisa saling
meng-kick dan menyisakan dua sesi hidup. Saya tidak melacak ini lebih jauh dan
tidak menjalankan `cargo test`; dicatat sebagai celah verifikasi, bukan temuan.

## 3. Framing — OK di bidi, celah di uni (N4-03)

- Format `[opcode][len u32 BE][payload]` identik di Rust (`protocol.rs:56`) dan
  klien (`web/src/workers/transport.worker.ts:79-83`) — kontrak wire terjaga.
- **bidi:** keputusan diambil dari header saja, sebelum payload dialokasikan
  (`main.rs:697-720`). `TooLarge` → `return` tanpa `vec!`. CHAFF → hitung metrik,
  `return`. HELLO → negosiasi, tidak diteruskan.
- **uni/datagram:** CHAFF, HELLO, dan frame terpotong tidak pernah diteruskan
  (`protocol.rs:170-190`; `main.rs:841-880`). HELLO di jalur yang salah dihitung
  `HelloWrongPath` — sinkron dengan `docs/29 §5.6`.
- **uni:** seluruh stream dibaca ke `Vec` tanpa cap, lalu di-parse dengan
  `usize::MAX` → **N4-03**. Ini satu-satunya tempat di mana "batas 32 KB" tidak
  berlaku, dan tidak ada tes yang menutupnya (tes `classify_orders_chaff_before_size_and_hello`
  justru menegaskan `usize::MAX` = "tanpa batas" untuk uni).
- **Datagram** aman secara ukuran karena QUIC membatasi ukuran datagram, tetapi
  tetap memakai `usize::MAX`; tidak ada masalah memori karena satu paket.

## 4. Parser HELLO — OK

`parse_transport_hello` menolak: kosong, >4096 byte, bukan UTF-8/JSON, `v` di
luar `1..=65535`, `caps` >32, cap kosong atau >64 karakter
(`protocol.rs:66-84`). `negotiate_capabilities` hanya mengembalikan irisan
daftar server dan membuang duplikat; kapabilitas tak dikenal tidak pernah masuk
hasil. `hello_reply_payload` jatuh ke `{"v":1,"caps":[]}` bila serialisasi gagal
(bukan panic). Balasan memakai opcode HELLO (0x0B) — bukan ACK (0x06) — dan ini
dikunci tes karena memakai 0x06 akan merusak jalur ACK klien.

**Catatan desain:** `SERVER_CAPABILITIES` di Rust **disalin** dari
`packages/shared` (bukan dibaca dari sana). Komentar menyebut sinkronisasi
manual; tidak ada tes lintas bahasa yang membandingkan keduanya. Bukan temuan
(AGENTS.md mendokumentasikannya sebagai kontrak), tetapi ini titik drift yang
tak terdeteksi otomatis.

## 5. Sertifikat lokal — OK, dan alasan fallback senyap tertutup

`local_cert_is_usable` menolak sertifikat dengan rentang >14 hari (batas
`serverCertificateHashes` Chrome), yang belum berlaku, yang kedaluwarsa, atau
yang sisa masa berlakunya <24 jam (`main.rs:44-78`) — lalu menerbitkan yang baru
(10 hari). Tanpa cek ini, sertifikat tersimpan akan dipakai setelah kedaluwarsa
dan **setiap** koneksi WebTransport ditolak Chrome, dengan klien diam-diam jatuh
ke WSS. Ini persis pola kegagalan senyap yang docs/29 §5.6 sebut; sekarang
tertutup di sisi server.

## 6. Sesi & pembersihan

- `sessions.remove(&session_key)` setelah `conn.closed()` (`main.rs:920-922`),
  dan opcode 99 dipublikasikan ke Node saat disconnect — jadi presence/`online`
  tidak menggantung.
- `sessions` adalah `DashMap<String, Arc<Connection>>` dengan kunci
  `user:device:uuid`; tidak ada kebocoran referensi `Connection` setelah close.

## 7. Ringkas: apa yang tidak saya periksa

- **`cargo test` / `clippy` / `audit` tidak dijalankan** — semua di atas adalah
  pembacaan kode. Tidak ada klaim kompilasi.
- `metrics.rs` (exporter loopback 9465, label enum) tidak dibaca rinci; klaim
  "loopback-only" hanya saya lihat dari `parse_metrics_addr` dipanggil dengan
  `TRANSPORT_METRICS_ADDR` (`main.rs:245-255`), bukan dari seluruh berkasnya.
- `fuzz.rs` dan `fuzz-framing` tidak dijalankan; sifat determinisme (xorshift)
  tidak saya verifikasi sendiri.
- `packages/spqr-wasm` (braid SPQR di Rust) dan `spqrRatchet.ts` tetap belum
  dibaca — ini utang cakupan terbesar yang tersisa di sisi klien.
- Interaksi sidecar ↔ `redisBridge` Node (format `UpstreamMessage`, opcode 99,
  pembatasan payload di sisi Node) tidak ditelusuri; N4-03 menyebut akibat di
  jalur Redis, bukan perilaku consumer-nya.
