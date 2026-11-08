// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use data_encoding::BASE64URL_NOPAD;
use nyx_pir_sidecar::http::{AppState, router};
use nyx_pir_sidecar::shard::{Manifest, Shard, ShardFile, db_root};
use serde_json::{Value, json};
use tower::ServiceExt;

const RECORD_BYTES: usize = 256;
const SLOTS: u32 = 64;

fn slots_fixture(slot_count: usize) -> Vec<u8> {
    (0..slot_count)
        .flat_map(|slot| {
            (0..RECORD_BYTES).map(move |byte| (slot as u8).wrapping_mul(11) ^ byte as u8)
        })
        .collect()
}

fn manifest(shard: u32, shard_count: u32, epoch: u64, slots: &[u8]) -> Manifest {
    Manifest {
        suite: "xor-pir-v1".to_string(),
        shard,
        shard_count,
        slot_count: SLOTS,
        record_bytes: RECORD_BYTES as u32,
        epoch,
        entry_count: SLOTS / 2,
        db_root: db_root(slots, RECORD_BYTES),
        operator: format!("nyx-{shard}"),
        key_id: "c".repeat(64),
    }
}

fn shard(shard: u32, epoch: u64, slots: Vec<u8>) -> Shard {
    Shard::from_parts(
        ShardFile {
            manifest: manifest(shard, 2, epoch, &slots),
            signature: format!("sig-{shard}"),
        },
        slots,
    )
    .expect("shard valid")
}

fn state_with_shards() -> AppState {
    let state = AppState::new("a", Some(b"admin-token".to_vec()));
    state
        .shards
        .install(shard(0, 1, slots_fixture(64)))
        .unwrap();
    state
        .shards
        .install(shard(1, 1, slots_fixture(64)))
        .unwrap();
    state
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn health_reports_role_and_loaded_shards() {
    let app = router(state_with_shards());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["status"], "ok");
    assert_eq!(body["role"], "a");
    assert_eq!(body["shards"], 2);
    assert_eq!(body["shardCount"], 2);
    assert_eq!(body["epoch"], 1);
}

#[tokio::test]
async fn manifest_endpoint_returns_signed_manifest() {
    let app = router(state_with_shards());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/manifest?shard=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = json_body(response).await;
    assert_eq!(body["manifest"]["shard"], 1);
    assert_eq!(body["manifest"]["shardCount"], 2);
    assert_eq!(
        body["manifest"]["dbRoot"],
        db_root(&slots_fixture(64), RECORD_BYTES)
    );
    assert_eq!(body["signature"], "sig-1");

    let unknown = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/manifest?shard=9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_body(unknown).await["error"], "PIR_SHARD_UNKNOWN");

    let missing = app
        .oneshot(
            Request::builder()
                .uri("/manifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(missing).await["error"], "PIR_SHARD_REQUIRED");
}

#[tokio::test]
async fn query_returns_share_answer() {
    let app = router(state_with_shards());
    let slots = slots_fixture(64);
    let mut q1 = vec![0u8; 8];
    rand::fill(&mut q1[..]);
    let mut q2 = q1.clone();
    nyx_pir_sidecar::pir::toggle(&mut q2, 17);

    let a1 = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/query?shard=0")
                .header("content-type", "application/octet-stream")
                .body(Body::from(q1))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(a1.status(), StatusCode::OK);
    let a1 = to_bytes(a1.into_body(), 64 * 1024).await.unwrap();

    let a2 = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/query?shard=0")
                .header("content-type", "application/octet-stream")
                .body(Body::from(q2))
                .unwrap(),
        )
        .await
        .unwrap();
    let a2 = to_bytes(a2.into_body(), 64 * 1024).await.unwrap();

    let recovered: Vec<u8> = a1.iter().zip(a2.iter()).map(|(a, b)| a ^ b).collect();
    assert_eq!(recovered, slots[17 * RECORD_BYTES..18 * RECORD_BYTES]);

    let short = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/query?shard=0")
                .body(Body::from(vec![0u8; 3]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(short.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(short).await["error"], "PIR_SHARE_INVALID");

    let unknown = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/query?shard=7")
                .body(Body::from(vec![0u8; 8]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
}

fn rebuild_body(shard: u32, epoch: u64) -> String {
    let slots = slots_fixture(64);
    let manifest = manifest(shard, 2, epoch, &slots);
    json!({
        "manifest": manifest,
        "signature": format!("sig-{epoch}"),
        "slots": BASE64URL_NOPAD.encode(&slots),
    })
    .to_string()
}

#[tokio::test]
async fn admin_rebuild_requires_token_and_rejects_stale_epoch() {
    let app = router(state_with_shards());

    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/admin/rebuild")
                .body(Body::from(rebuild_body(0, 2)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(json_body(denied).await["error"], "PIR_ADMIN_FORBIDDEN");

    let accepted = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/admin/rebuild")
                .header("x-nyx-pir-internal", "admin-token")
                .body(Body::from(rebuild_body(0, 2)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let body = json_body(accepted).await;
    assert_eq!(body["epoch"], 2);
    assert_eq!(body["shard"], 0);

    let stale = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/admin/rebuild")
                .header("x-nyx-pir-internal", "admin-token")
                .body(Body::from(rebuild_body(0, 1)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(json_body(stale).await["error"], "PIR_EPOCH_STALE");

    let manifest = app
        .oneshot(
            Request::builder()
                .uri("/manifest?shard=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(manifest).await["manifest"]["epoch"], 2);
}

#[tokio::test]
async fn admin_rebuild_rejects_slots_that_do_not_match_db_root() {
    let app = router(state_with_shards());
    let slots = slots_fixture(64);
    let mut manifest = manifest(0, 2, 3, &slots);
    manifest.db_root = "d".repeat(64);
    let body = json!({
        "manifest": manifest,
        "signature": "sig",
        "slots": BASE64URL_NOPAD.encode(&slots),
    })
    .to_string();
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/admin/rebuild")
                .header("x-nyx-pir-internal", "admin-token")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(response).await["error"], "PIR_SHARD_INVALID");
}
