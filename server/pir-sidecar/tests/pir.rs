// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use chalametpir_client::Client;
use data_encoding::BASE64URL_NOPAD;
use nyx_pir_sidecar::http::{AppState, router};
use nyx_pir_sidecar::index::build_index;
use nyx_pir_sidecar::snapshot::{Snapshot, SnapshotEntry};
use serde_json::{Value, json};
use tower::ServiceExt;

const RECORD_BYTES: usize = 256;

fn snapshot(entries: usize, epoch: u64) -> Snapshot {
    let mut items = Vec::with_capacity(entries);
    for index in 0..entries {
        let value = vec![(index as u8).wrapping_add(1); RECORD_BYTES];
        items.push(SnapshotEntry {
            oprf: BASE64URL_NOPAD.encode(&[index as u8; 32]),
            value: BASE64URL_NOPAD.encode(&value),
        });
    }
    Snapshot {
        epoch,
        record_bytes: RECORD_BYTES,
        entries: items,
    }
}

#[test]
fn end_to_end_query_returns_exact_record() {
    let index = build_index(snapshot(8, 1).validate(100).unwrap(), Some(b"master"), 3).unwrap();
    let mut client = Client::setup(&index.seed, &index.hint, &index.filter).unwrap();

    let oprf = [7u8; 32];
    let query = client.query(&oprf).unwrap();
    let response = index.respond(&query).unwrap();
    let value = client.process_response(&oprf, &response).unwrap();

    assert_eq!(value.len(), RECORD_BYTES);
    assert_eq!(value, vec![8u8; RECORD_BYTES]);
}

#[tokio::test]
async fn http_health_params_rebuild_and_query() {
    let state = AppState::new(
        Some(b"master".to_vec()),
        Some(b"admin-token".to_vec()),
        3,
        100,
    );
    let app = router(state);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let health: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(health["status"], "empty");

    let body = serde_json::to_vec(&snapshot(8, 2)).unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::post("/admin/rebuild")
                .header("content-type", "application/json")
                .header("x-nyx-pir-internal", "admin-token")
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(
            Request::post("/admin/rebuild")
                .header("content-type", "application/json")
                .header("x-nyx-pir-internal", "admin-token")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);

    let response = app
        .clone()
        .oneshot(
            Request::post("/admin/rebuild")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&snapshot(8, 3)).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/params")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let params: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(params["epoch"], 2);
    assert_eq!(params["entryCount"], 8);
    assert_eq!(params["suite"], "chalametpir-v1");

    let seed: [u8; 32] = BASE64URL_NOPAD
        .decode(params["seed"].as_str().unwrap().as_bytes())
        .unwrap()
        .try_into()
        .unwrap();
    let hint = BASE64URL_NOPAD
        .decode(params["hint"].as_str().unwrap().as_bytes())
        .unwrap();
    let filter = BASE64URL_NOPAD
        .decode(params["filter"].as_str().unwrap().as_bytes())
        .unwrap();
    let mut client = Client::setup(&seed, &hint, &filter).unwrap();
    let oprf = [3u8; 32];
    let query = client.query(&oprf).unwrap();

    let response = app
        .oneshot(Request::post("/query").body(Body::from(query)).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response_bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = client.process_response(&oprf, &response_bytes).unwrap();
    assert_eq!(value, vec![4u8; RECORD_BYTES]);
}

#[tokio::test]
async fn missing_snapshot_is_service_unavailable() {
    let state = AppState::new(None, None, 3, 100);
    let app = router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/params")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"], "PIR_NOT_READY");
    assert_eq!(json!(body["epoch"]), Value::Null);
}
