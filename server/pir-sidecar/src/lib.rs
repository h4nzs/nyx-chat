// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/42] PIR dua server (`xor-pir-v1`).
//!
//! Kripto/protokol murni ada di `pir`/`shard` supaya `cargo test` bisa menguji
//! penempatan, XOR, dan hot-swap tanpa membuka socket. `main.rs` hanya membaca
//! env, memuat shard, dan melayani HTTP.

pub mod http;
pub mod pir;
pub mod shard;
