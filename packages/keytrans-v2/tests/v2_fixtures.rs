// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact admin@nyx-app.my.id.

//! [docs/35 §35.7 Fase 7] Cross-implementation oracle for Key Transparency v2.
//!
//! The fixtures under `packages/keytrans-wasm-v2/testdata/` are produced by the
//! Go v2 log (`server/kt-query/cmd/kt-v2-fixtures`) with ML-DSA-65 tree heads
//! and no VRF. These tests verify those bytes with the Rust fork the client
//! actually ships — a shared mistake in either implementation cannot pass.
//!
//! Regenerate with:
//!   cd server/kt-query && go run ./cmd/kt-v2-fixtures \
//!     -out ../../packages/keytrans-wasm-v2/testdata

use std::time::{Duration, UNIX_EPOCH};

use libsignal_keytrans_v2::{
    CondensedTreeSearchResponse, DeploymentMode, FullSearchResponse, FullTreeHead,
    KeyTransparency, LastTreeHead, PublicConfig, SearchContext, SlimSearchRequest, VerifyingKey,
};
use prost::Message;

const FIRST: &[u8] = include_bytes!("../../keytrans-wasm-v2/testdata/search-first.bin");
const FIRST_CFG: &str = include_str!("../../keytrans-wasm-v2/testdata/search-first.bin.json");
const ANCHORED: &[u8] = include_bytes!("../../keytrans-wasm-v2/testdata/search-anchored.bin");
const ANCHORED_CFG: &str = include_str!("../../keytrans-wasm-v2/testdata/search-anchored.bin.json");
const AUDITED: &[u8] = include_bytes!("../../keytrans-wasm-v2/testdata/search-audited.bin");
const AUDITED_CFG: &str = include_str!("../../keytrans-wasm-v2/testdata/search-audited.bin.json");

struct Config {
    mode: u8,
    signature_key: Vec<u8>,
    auditor_keys: Vec<Vec<u8>>,
    search_key: Vec<u8>,
    value: Vec<u8>,
    verify_now_ms: u64,
}

impl Config {
    fn parse(raw: &str) -> Self {
        let value: serde_json::Value = serde_json::from_str(raw).expect("config JSON");
        Self {
            mode: value["mode"].as_u64().expect("mode") as u8,
            signature_key: hex::decode(value["signatureKey"].as_str().expect("signatureKey"))
                .expect("signatureKey hex"),
            auditor_keys: value["auditorKeys"]
                .as_array()
                .expect("auditorKeys")
                .iter()
                .map(|key| hex::decode(key.as_str().expect("auditor key")).expect("auditor key hex"))
                .collect(),
            search_key: hex::decode(value["searchKey"].as_str().expect("searchKey"))
                .expect("searchKey hex"),
            value: hex::decode(value["value"].as_str().expect("value")).expect("value hex"),
            verify_now_ms: value["verifyNowMs"].as_u64().expect("verifyNowMs"),
        }
    }

    fn public(&self) -> PublicConfig {
        let signature_key =
            VerifyingKey::from_bytes(&self.signature_key).expect("log ML-DSA public key");
        let mode = match self.mode {
            1 => DeploymentMode::ContactMonitoring,
            2 => DeploymentMode::ThirdPartyManagement(
                self.auditor_keys
                    .iter()
                    .map(|raw| VerifyingKey::from_bytes(raw).expect("auditor ML-DSA key"))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            3 => DeploymentMode::ThirdPartyAuditing(
                self.auditor_keys
                    .iter()
                    .map(|raw| VerifyingKey::from_bytes(raw).expect("auditor ML-DSA key"))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            other => panic!("unknown mode {other}"),
        };
        PublicConfig {
            mode,
            signature_key,
        }
    }
}

fn split_frame(raw: &[u8]) -> (FullTreeHead, CondensedTreeSearchResponse) {
    let read_len = |offset: usize| -> usize {
        u32::from_be_bytes(raw[offset..offset + 4].try_into().unwrap()) as usize
    };
    let head_len = read_len(0);
    let head = FullTreeHead::decode(&raw[4..4 + head_len]).expect("FullTreeHead");
    let offset = 4 + head_len;
    let condensed_len = read_len(offset);
    let condensed = CondensedTreeSearchResponse::decode(&raw[offset + 4..offset + 4 + condensed_len])
        .expect("CondensedTreeSearchResponse");
    (head, condensed)
}

fn verify(
    raw: &[u8],
    config: &Config,
    last: Option<LastTreeHead>,
) -> libsignal_keytrans_v2::VerifiedSearchResult {
    let (head, condensed) = split_frame(raw);
    let kt = KeyTransparency {
        config: config.public(),
    };
    let now = UNIX_EPOCH + Duration::from_millis(config.verify_now_ms);
    kt.verify_search(
        SlimSearchRequest::new(config.search_key.clone()),
        FullSearchResponse::new(condensed, &head),
        SearchContext {
            last_tree_head: last.as_ref(),
            last_distinguished_tree_head: None,
            data: None,
        },
        false,
        now,
    )
    .expect("v2 search proof must verify")
}

#[test]
fn go_v2_log_is_verified_by_rust() {
    let config = Config::parse(FIRST_CFG);
    let result = verify(FIRST, &config, None);
    assert_eq!(result.value, config.value);
    assert!(result.value.len() > 3000, "expected a full v2 log value");
}

#[test]
fn anchored_consistency_proof_is_verified() {
    let first_config = Config::parse(FIRST_CFG);
    let first = verify(FIRST, &first_config, None);
    let anchor = LastTreeHead(first.state_update.tree_head, first.state_update.tree_root);

    let config = Config::parse(ANCHORED_CFG);
    let anchored = verify(ANCHORED, &config, Some(anchor));
    assert_eq!(anchored.value, config.value);
}

#[test]
fn third_party_auditor_head_is_verified() {
    let config = Config::parse(AUDITED_CFG);
    let (head, _) = split_frame(AUDITED);
    assert_eq!(head.full_auditor_tree_heads.len(), 1);
    let result = verify(AUDITED, &config, None);
    assert_eq!(result.value, config.value);
}

#[test]
fn tampered_signatures_and_v1_vrf_are_rejected() {
    // Mode 3 is where `to_single_signature_tree_heads` actually has keys to
    // match; ContactMonitoring (mode 1) never verifies tree-head signatures in
    // upstream, so tampering tests use the audited fixture.
    let config = Config::parse(AUDITED_CFG);
    let kt = KeyTransparency {
        config: config.public(),
    };
    let now = UNIX_EPOCH + Duration::from_millis(config.verify_now_ms);
    let context = || SearchContext {
        last_tree_head: None,
        last_distinguished_tree_head: None,
        data: None,
    };

    let (mut head, condensed) = split_frame(AUDITED);
    head.tree_head.as_mut().unwrap().signatures[0].signature[0] ^= 0xff;
    assert!(kt
        .verify_search(
            SlimSearchRequest::new(config.search_key.clone()),
            FullSearchResponse::new(condensed, &head),
            context(),
            false,
            now,
        )
        .is_err());

    let (mut head, condensed) = split_frame(AUDITED);
    head.full_auditor_tree_heads[0]
        .tree_head
        .as_mut()
        .unwrap()
        .signature[0] ^= 0xff;
    assert!(kt
        .verify_search(
            SlimSearchRequest::new(config.search_key.clone()),
            FullSearchResponse::new(condensed, &head),
            context(),
            false,
            now,
        )
        .is_err());

    let config = Config::parse(FIRST_CFG);
    let kt = KeyTransparency {
        config: config.public(),
    };
    let now = UNIX_EPOCH + Duration::from_millis(config.verify_now_ms);
    let (head, mut condensed) = split_frame(FIRST);
    condensed.vrf_proof = vec![1u8; 80];
    assert!(kt
        .verify_search(
            SlimSearchRequest::new(config.search_key.clone()),
            FullSearchResponse::new(condensed, &head),
            context(),
            false,
            now,
        )
        .is_err());
}
