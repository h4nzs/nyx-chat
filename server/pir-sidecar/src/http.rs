// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! Loopback HTTP surface for the PIR sidecar.
//!
//! Public routes (`/health`, `/params`, `/query`) are proxied by the Node API.
//! `/admin/rebuild` is intentionally sidecar-only and requires the internal
//! token; it is never mounted through nginx.

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;

use crate::index::{PirIndex, SUITE, build_index};
use crate::snapshot::Snapshot;

pub const MAX_QUERY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    index: Arc<RwLock<Option<Arc<PirIndex>>>>,
    master_secret: Option<Arc<Vec<u8>>>,
    admin_token: Option<Arc<Vec<u8>>>,
    arity: u32,
    max_entries: usize,
}

impl AppState {
    pub fn new(
        master_secret: Option<Vec<u8>>,
        admin_token: Option<Vec<u8>>,
        arity: u32,
        max_entries: usize,
    ) -> Self {
        Self {
            index: Arc::new(RwLock::new(None)),
            master_secret: master_secret.map(Arc::new),
            admin_token: admin_token.map(Arc::new),
            arity,
            max_entries,
        }
    }

    pub async fn install(&self, index: PirIndex) {
        *self.index.write().await = Some(Arc::new(index));
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/params", get(params))
        .route(
            "/query",
            post(query).layer(DefaultBodyLimit::max(MAX_QUERY_BYTES)),
        )
        .route(
            "/admin/rebuild",
            post(rebuild).layer(DefaultBodyLimit::max(MAX_SNAPSHOT_BYTES)),
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

    fn unavailable(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
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

async fn health(State(state): State<AppState>) -> Json<Value> {
    let current = state.index.read().await;
    match current.as_ref() {
        Some(index) => Json(json!({
            "status": "ok",
            "epoch": index.epoch,
            "entryCount": index.entry_count,
            "recordBytes": index.record_bytes,
            "suite": SUITE,
            "arity": index.arity,
        })),
        None => Json(json!({
            "status": "empty",
            "epoch": 0,
            "entryCount": 0,
            "recordBytes": 0,
            "suite": SUITE,
            "arity": state.arity,
        })),
    }
}

async fn params(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let current = state.index.read().await;
    let index = current.as_ref().ok_or_else(|| {
        ApiError::unavailable("PIR_NOT_READY", "belum ada snapshot PIR yang dimuat")
    })?;

    let etag = index.etag();
    if let Some(inm) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
    {
        if inm == etag || inm == "*" {
            return Ok(StatusCode::NOT_MODIFIED.into_response());
        }
    }

    let mut response = Response::new(index.params().to_vec().into());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(|_| ApiError::internal("build etag", etag.clone()))?,
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60"),
    );
    Ok(response)
}

async fn query(State(state): State<AppState>, body: Bytes) -> Result<Response, ApiError> {
    if body.is_empty() {
        return Err(ApiError::bad_request(
            "PIR_QUERY_REQUIRED",
            "body query PIR kosong",
        ));
    }

    let index = {
        let current = state.index.read().await;
        current
            .as_ref()
            .cloned()
            .ok_or_else(|| ApiError::unavailable("PIR_NOT_READY", "belum ada snapshot PIR"))?
    };
    let query = body.to_vec();
    let response = tokio::task::spawn_blocking(move || index.respond(&query))
        .await
        .map_err(|error| ApiError::internal("join query", error))?
        .map_err(|error| ApiError::internal("respond query", error))?;

    let mut response = Response::new(response.into());
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

fn token_matches(provided: &[u8], expected: &[u8]) -> bool {
    provided.len() == expected.len() && bool::from(provided.ct_eq(expected))
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

    let snapshot: Snapshot = serde_json::from_slice(&body)
        .map_err(|_| ApiError::bad_request("PIR_SNAPSHOT_INVALID", "snapshot bukan JSON valid"))?;

    let current_epoch = {
        let current = state.index.read().await;
        current.as_ref().map(|index| index.epoch).unwrap_or(0)
    };
    if snapshot.epoch <= current_epoch {
        return Err(ApiError::conflict(
            "PIR_EPOCH_STALE",
            format!(
                "epoch {} harus lebih besar dari epoch aktif {}",
                snapshot.epoch, current_epoch
            ),
        ));
    }

    let master_secret = state
        .master_secret
        .as_ref()
        .map(|secret| secret.as_slice().to_vec());
    let arity = state.arity;
    let max_entries = state.max_entries;
    let built = tokio::task::spawn_blocking(move || {
        let validated = snapshot.validate(max_entries)?;
        build_index(validated, master_secret.as_deref(), arity)
    })
    .await
    .map_err(|error| ApiError::internal("join rebuild", error))?
    .map_err(|error| {
        ApiError::bad_request("PIR_SNAPSHOT_INVALID", format!("snapshot ditolak: {error}"))
    })?;

    let epoch = built.epoch;
    let entry_count = built.entry_count;
    let record_bytes = built.record_bytes;
    {
        let mut current = state.index.write().await;
        if let Some(existing) = current.as_ref() {
            if epoch <= existing.epoch {
                return Err(ApiError::conflict(
                    "PIR_EPOCH_STALE",
                    "epoch berubah selama rebuild; coba lagi dengan epoch lebih baru",
                ));
            }
        }
        *current = Some(Arc::new(built));
    }

    Ok(Json(json!({
        "status": "ok",
        "epoch": epoch,
        "entryCount": entry_count,
        "recordBytes": record_bytes,
    })))
}
