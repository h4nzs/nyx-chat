// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use nyx_pir_sidecar::http::{AppState, router};
use nyx_pir_sidecar::index::build_index;
use nyx_pir_sidecar::snapshot::Snapshot;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_ENTRIES: usize = 1_000_000;

fn parse_usize(name: &str, default: usize) -> Result<usize> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value
            .trim()
            .parse::<usize>()
            .with_context(|| format!("{name} harus bilangan bulat")),
        _ => Ok(default),
    }
}

fn parse_arity() -> Result<u32> {
    let arity = parse_usize("PIR_ARITY", 3)?;
    if arity != 3 && arity != 4 {
        bail!("PIR_ARITY harus 3 atau 4");
    }
    Ok(arity as u32)
}

fn load_snapshot(path: &PathBuf) -> Result<Option<Snapshot>> {
    if !path.exists() {
        warn!(path = %path.display(), "snapshot PIR tidak ditemukan; layanan mulai kosong");
        return Ok(None);
    }
    let bytes = std::fs::read(path)
        .with_context(|| format!("gagal membaca snapshot {}", path.display()))?;
    let snapshot: Snapshot = serde_json::from_slice(&bytes)
        .with_context(|| format!("snapshot {} bukan JSON valid", path.display()))?;
    Ok(Some(snapshot))
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

    let master_secret = env::var("PIR_MASTER_SECRET")
        .ok()
        .filter(|value| !value.is_empty())
        .map(String::into_bytes);
    if master_secret.is_none() {
        warn!("PIR_MASTER_SECRET kosong: seed epoch acak per restart dan hint klien tidak stabil");
    }

    let admin_token = env::var("PIR_ADMIN_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
        .map(String::into_bytes);
    if admin_token.is_none() {
        warn!("PIR_ADMIN_TOKEN kosong: /admin/rebuild dinonaktifkan");
    }

    let arity = parse_arity()?;
    let max_entries = parse_usize("PIR_MAX_ENTRIES", DEFAULT_ENTRIES)?;
    if max_entries == 0 {
        bail!("PIR_MAX_ENTRIES harus > 0");
    }

    let state = AppState::new(master_secret.clone(), admin_token, arity, max_entries);
    let snapshot_path = PathBuf::from(
        env::var("PIR_SNAPSHOT_PATH").unwrap_or_else(|_| "pir-snapshot.json".to_string()),
    );
    if let Some(snapshot) = load_snapshot(&snapshot_path)? {
        let epoch = snapshot.epoch;
        let record_bytes = snapshot.record_bytes;
        let entry_count = snapshot.entries.len();
        let validated = snapshot.validate(max_entries)?;
        let index = build_index(validated, master_secret.as_deref(), arity)
            .context("gagal membangun index PIR dari snapshot awal")?;
        state.install(index).await;
        info!(
            path = %snapshot_path.display(),
            epoch,
            entry_count,
            record_bytes,
            "snapshot PIR dimuat"
        );
    }

    let app = router(state);
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("gagal bind {addr}"))?;
    info!(%addr, "PIR sidecar berjalan");
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
