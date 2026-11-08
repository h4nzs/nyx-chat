// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/42 WP4] Sidecar XOR-PIR: satu binary, role A atau B.
//!
//! Tidak ada kripto di sini — modul `pir`/`shard` murni dan diuji tanpa socket.
//! `main.rs` hanya membaca env, memuat shard dari disk, dan melayani HTTP.

use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use nyx_pir_sidecar::http::{AppState, router};
use nyx_pir_sidecar::shard::Shard;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_SHARD_DIR: &str = "pir-shards";

fn parse_role() -> Result<String> {
    let role = env::var("PIR_ROLE").unwrap_or_else(|_| "a".to_string());
    match role.trim() {
        "a" | "b" => Ok(role.trim().to_string()),
        other => bail!("PIR_ROLE harus 'a' atau 'b' (didapat {other})"),
    }
}

/// Muat semua `shard-<n>.json` di direktori. Berkas shard yang cacat
/// menggagalkan boot: lebih baik layanan mati daripada menyajikan data salah.
fn load_shards(state: &AppState, dir: &Path) -> Result<usize> {
    if !dir.exists() {
        warn!(dir = %dir.display(), "direktori shard tidak ada; layanan mulai kosong");
        return Ok(0);
    }

    let mut manifests: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("gagal membaca direktori {}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "json")
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("shard-"))
        })
        .collect();
    manifests.sort();

    let mut loaded = 0;
    for manifest_path in &manifests {
        let bin_path = manifest_path.with_extension("bin");
        let shard = Shard::from_files(&bin_path, manifest_path)?;
        let shard_id = shard.manifest.shard;
        let epoch = shard.manifest.epoch;
        let entries = shard.manifest.entry_count;
        state.shards.install(shard).map_err(|error| {
            anyhow::anyhow!("shard {shard_id} ditolak saat boot: {}", error.code())
        })?;
        loaded += 1;
        info!(shard = shard_id, epoch, entries, "shard PIR dimuat");
    }
    Ok(loaded)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("nyx_pir_sidecar=info")),
        )
        .init();

    let bind = env::var("PIR_BIND").unwrap_or_else(|_| "127.0.0.1:9470".to_string());
    let addr: SocketAddr = bind
        .parse()
        .with_context(|| format!("PIR_BIND bukan alamat valid: {bind}"))?;
    if !addr.ip().is_loopback() {
        bail!("PIR_BIND harus loopback (127.0.0.1 / ::1)");
    }

    let role = parse_role()?;
    let admin_token = env::var("PIR_ADMIN_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
        .map(String::into_bytes);
    if admin_token.is_none() {
        warn!("PIR_ADMIN_TOKEN kosong: /admin/rebuild dinonaktifkan");
    }

    let state = AppState::new(role.clone(), admin_token);
    let dir =
        PathBuf::from(env::var("PIR_SHARD_DIR").unwrap_or_else(|_| DEFAULT_SHARD_DIR.to_string()));
    let loaded = load_shards(&state, &dir)?;
    if loaded == 0 {
        warn!(dir = %dir.display(), "tidak ada shard termuat; /manifest dan /query menjawab 404");
    }

    let app = router(state);
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("gagal bind {addr}"))?;
    info!(%addr, %role, shards = loaded, "PIR sidecar berjalan");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server PIR berhenti dengan error")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("gagal memasang handler Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("gagal memasang handler SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
