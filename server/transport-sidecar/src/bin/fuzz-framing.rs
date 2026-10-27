// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/30 WS-G(5)] Runner fuzz framing/HELLO untuk gate "fuzz ≥1 jam tanpa
//! crash" (§30.11 butir 4) — tanpa toolchain nightly.
//!
//! Contoh:
//!   cargo run --release --bin fuzz-framing                       # 10 detik (smoke)
//!   NYX_FUZZ_SECONDS=3600 cargo run --release --bin fuzz-framing # gate ≥1 jam
//!   NYX_FUZZ_ITERS=5000000 cargo run --release --bin fuzz-framing
//!
//! Exit code 1 + baris `TEMUAN:` (berisi seed/iterasi + input) bila ada temuan,
//! sehingga bisa dipakai di CI/nightly sebagai gate, bukan hanya alat manual.

use std::env;

fn env_u64(name: &str) -> Option<u64> {
    env::var(name).ok().and_then(|raw| {
        let trimmed = raw.trim();
        let parsed = trimmed
            .strip_prefix("0x")
            .map(|hex| u64::from_str_radix(hex, 16))
            .unwrap_or_else(|| trimmed.parse::<u64>());
        parsed.ok()
    })
}

fn env_f64(name: &str) -> Option<f64> {
    env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
}

fn main() {
    let seed = env_u64("NYX_FUZZ_SEED").unwrap_or(0x1f2e_3d4c);
    let iterations = env_u64("NYX_FUZZ_ITERS");
    let seconds = env_f64("NYX_FUZZ_SECONDS").or_else(|| {
        if iterations.is_some() {
            None
        } else {
            // Default singkat: aman dijalankan tanpa env (smoke test).
            Some(10.0)
        }
    });
    let progress_every = env_u64("NYX_FUZZ_PROGRESS_EVERY").unwrap_or(250_000);

    println!(
        "[fuzz-framing] seed=0x{seed:x} iterations={:?} seconds={:?}",
        iterations, seconds
    );

    match transport_sidecar::fuzz::run_campaign(seed, iterations, seconds, progress_every) {
        Ok(stats) => {
            println!(
                "[fuzz-framing] selesai tanpa temuan: {} iterasi dalam {} ms ({} iterasi/detik)",
                stats.iterations,
                stats.ms,
                stats.per_second()
            );
        }
        Err(repro) => {
            eprintln!("TEMUAN: {repro}");
            eprintln!("[fuzz-framing] ulangi dengan: NYX_FUZZ_SEED=<seed di atas> cargo run --release --bin fuzz-framing");
            std::process::exit(1);
        }
    }
}
