// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/30 WS-G(5)] Bagian sidecar yang **murni** (tanpa soket/Redis) supaya
//! bisa diuji dan di-fuzz dari binary kedua (`fuzz-framing`) maupun `cargo test`.
//!
//! `main.rs` tetap memegang I/O WebTransport/Redis; modul di sini hanya
//! keputusan protokol: bingkai `[opcode][len:u32 BE][payload]` dan HELLO
//! (negosiasi kapabilitas). Kontrak numeriknya sinkron dengan
//! `packages/shared/src/transport.ts`.

pub mod fuzz;
pub mod protocol;
