// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/42 WP4] Permukaan HTTP sidecar XOR-PIR.
//!
//! Satu binary, satu role (`PIR_ROLE=a|b`). Endpoint publik diproxy oleh API
//! Node; `/admin/rebuild` hanya loopback dan butuh token internal, jadi jangan
//! pernah dipasang lewat nginx.
//!
//! | Route | Isi |
//! |---|---|
//! | `GET /health` | role, shard termuat, epoch tertinggi |
//! | `GET /manifest?shard=N` | `{manifest, signature}` untuk satu shard |
//! | `POST /query?shard=N` | share biner → jawaban XOR sepanjang `recordBytes` |
//! | `POST /admin/rebuild` | `{manifest, signature, slots}` (base64url) |

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use data_encoding::BASE64URL_NOPAD;
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::pir::share_len;
use crate::shard::{InstallError, Shard, ShardFile, ShardSet};

/// Cukup untuk `S = 524288` slot; query normal `S/8` byte (512 B pada S=4096).
pub const MAX_SHARE_BYTES: usize = 64 * 1024;
pub const MAX_SLOTS_BYTES: usize = 128 * 1024 * 1024;
/// Base64url membengkak 4/3, plus amplop JSON.
pub const MAX_REBUILD_BYTES: usize = MAX_SLOTS_BYTES / 3 * 4 + 1024;

#[derive(Clone)]
pub struct AppState {
    pub shards: Arc<ShardSet>,
    admin_token: Option<Arc<Vec<u8>>>,
    role: String,
}

impl AppState {
    pub fn new(role: impl Into<String>, admin_token: Option<Vec<u8>>) -> Self {
        Self {
            shards: Arc::new(ShardSet::new()),
            admin_token: admin_token.map(Arc::new),
            role: role.into(),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/manifest", get(manifest))
        .route(
            "/query",
            post(query).layer(DefaultBodyLimit::max(MAX_SHARE_BYTES)),
        )
        .route(
            "/admin/rebuild",
            post(rebuild).layer(DefaultBodyLimit::max(MAX_REBUILD_BYTES)),
        )
        .with_state(state)
}

struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }

    fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code,
            message: message.into(),
        }
    }

    fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code,
            message: message.into(),
        }
    }

    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
        }
    }

    fn internal(context: &'static str, error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, context, "PIR internal error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "PIR_INTERNAL",
            message: "PIR internal error".into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.code, "message": self.message })),
        )
            .into_response()
    }
}

#[derive(Debug, Deserialize)]
struct ShardQuery {
    shard: Option<u32>,
}

fn shard_param(query: &ShardQuery) -> Result<u32, ApiError> {
    query
        .shard
        .ok_or_else(|| ApiError::bad_request("PIR_SHARD_REQUIRED", "parameter shard wajib"))
}

fn load_shard(state: &AppState, shard: u32) -> Result<Arc<Shard>, ApiError> {
    state.shards.get(shard).ok_or_else(|| {
        ApiError::not_found(
            "PIR_SHARD_UNKNOWN",
            format!("shard {shard} belum dimuat sidecar ini"),
        )
    })
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": if state.shards.installed() == 0 { "empty" } else { "ok" },
        "role": state.role,
        "epoch": state.shards.epoch(),
        "shards": state.shards.installed(),
        "shardCount": state.shards.shard_count().unwrap_or(0),
        "entryCount": state.shards.entry_count(),
    }))
}

async fn manifest(
    State(state): State<AppState>,
    Query(query): Query<ShardQuery>,
) -> Result<Response, ApiError> {
    let shard = load_shard(&state, shard_param(&query)?)?;
    let mut response = Json(json!({
        "manifest": shard.manifest,
        "signature": shard.signature,
    }))
    .into_response();
    // Manifest harus bisa berubah kapan saja (rebuild per shard); cache lama
    // akan membuat klien membandingkan dua epoch yang sudah tidak berlaku.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

async fn query(
    State(state): State<AppState>,
    Query(query): Query<ShardQuery>,
    body: Bytes,
) -> Result<Response, ApiError> {
    let shard = load_shard(&state, shard_param(&query)?)?;
    if body.len() != shard.share_len() {
        return Err(ApiError::bad_request(
            "PIR_SHARE_INVALID",
            format!("share harus {} byte", shard.share_len()),
        ));
    }
    if body.is_empty() {
        return Err(ApiError::bad_request("PIR_SHARE_INVALID", "share kosong"));
    }
    let share = body.to_vec();
    let response = tokio::task::spawn_blocking(move || shard.answer(&share))
        .await
        .map_err(|error| ApiError::internal("join query", error))?
        .map_err(|error| ApiError::internal("answer query", error))?;

    let mut response = Response::new(response.into());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

fn token_matches(provided: &[u8], expected: &[u8]) -> bool {
    provided.len() == expected.len() && bool::from(provided.ct_eq(expected))
}

#[derive(Debug, Deserialize)]
struct RebuildBody {
    manifest: Value,
    signature: String,
    slots: String,
}

async fn rebuild(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let expected = state
        .admin_token
        .as_ref()
        .ok_or_else(|| ApiError::forbidden("PIR_ADMIN_DISABLED", "PIR_ADMIN_TOKEN belum diset"))?;
    let provided = headers
        .get("x-nyx-pir-internal")
        .map(|value| value.as_bytes())
        .unwrap_or_default();
    if !token_matches(provided, expected) {
        return Err(ApiError::forbidden(
            "PIR_ADMIN_FORBIDDEN",
            "token admin PIR tidak valid",
        ));
    }

    let parsed: RebuildBody = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("PIR_SHARD_INVALID", "body rebuild bukan JSON valid"))?;
    let file: ShardFile = serde_json::from_value(json!({
        "manifest": parsed.manifest,
        "signature": parsed.signature,
    }))
    .map_err(|error| {
        ApiError::bad_request("PIR_SHARD_INVALID", format!("manifest ditolak: {error}"))
    })?;
    let slots = BASE64URL_NOPAD
        .decode(parsed.slots.as_bytes())
        .map_err(|_| ApiError::bad_request("PIR_SHARD_INVALID", "slots bukan base64url"))?;
    if slots.len() > MAX_SLOTS_BYTES {
        return Err(ApiError::bad_request(
            "PIR_SHARD_INVALID",
            "slots melebihi batas",
        ));
    }

    let shard = Shard::from_parts(file, slots).map_err(|error| {
        ApiError::bad_request("PIR_SHARD_INVALID", format!("shard ditolak: {error}"))
    })?;
    let manifest = shard.manifest.clone();
    state
        .shards
        .install(shard)
        .map_err(|error| install_error(error, manifest.shard))?;

    Ok(Json(json!({
        "status": "ok",
        "shard": manifest.shard,
        "shardCount": manifest.shard_count,
        "epoch": manifest.epoch,
        "slotCount": manifest.slot_count,
        "entryCount": manifest.entry_count,
    })))
}

fn install_error(error: InstallError, shard: u32) -> ApiError {
    let message = match error {
        InstallError::ShardCountMismatch => {
            format!("shard {shard} memakai shardCount yang berbeda dari index aktif")
        }
        InstallError::EpochStale => format!("epoch shard {shard} lebih kecil dari yang aktif"),
        InstallError::EpochConflict => {
            format!("epoch shard {shard} sama tetapi dbRoot berbeda")
        }
    };
    ApiError::conflict(error.code(), message)
}

/// Share untuk `slot_count` slot; diekspor untuk tes integrasi.
pub fn expected_share_len(slot_count: usize) -> usize {
    share_len(slot_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_fit_real_shapes() {
        const { assert!(MAX_REBUILD_BYTES > MAX_SLOTS_BYTES) };
        assert!(MAX_SHARE_BYTES >= share_len(4096));
        assert_eq!(share_len(4096), 512);
    }
}
