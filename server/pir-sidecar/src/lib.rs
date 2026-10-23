// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/35 Fase 4b] PIR v1 sidecar.
//!
//! Pure library pieces live here so `cargo test` can exercise snapshot
//! validation and an end-to-end ChalametPIR query without opening a socket.
//! `main.rs` only handles environment, startup snapshot loading, and serving.

pub mod http;
pub mod index;
pub mod snapshot;
