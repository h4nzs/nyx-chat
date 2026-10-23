// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! Build and query the ChalametPIR index.
//!
//! The server is stateful per epoch: `setup` is the expensive offline phase and
//! produces a hint that clients cache. `respond` is the online phase and is
//! stateless per query. We never reimplement any PIR arithmetic here.

use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use chalametpir_server::{SEED_BYTE_LEN, Server};
use data_encoding::BASE64URL_NOPAD;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::snapshot::ValidatedSnapshot;

pub const SUITE: &str = "chalametpir-v1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParamsPayload {
    epoch: u64,
    record_bytes: usize,
    entry_count: usize,
    suite: &'static str,
    arity: u32,
    seed: String,
    hint: String,
    filter: String,
}

pub struct PirIndex {
    server: Server,
    pub epoch: u64,
    pub record_bytes: usize,
    pub entry_count: usize,
    pub seed: [u8; SEED_BYTE_LEN],
    pub hint: Vec<u8>,
    pub filter: Vec<u8>,
    pub arity: u32,
    params: Vec<u8>,
}

impl PirIndex {
    /// Serialized `/params` body, cached until the next rebuild.
    pub fn params(&self) -> &[u8] {
        &self.params
    }

    /// Answer one opaque PIR query.
    pub fn respond(&self, query: &[u8]) -> Result<Vec<u8>> {
        self.server
            .respond(query)
            .context("ChalametPIR gagal menjawab query")
    }

    pub fn etag(&self) -> String {
        format!("\"pir-{}\"", self.epoch)
    }
}

/// Derive the per-epoch ChalametPIR seed. The epoch is part of the derivation
/// so a rebuild can never reuse the previous hint under a new label.
pub fn derive_seed(master_secret: Option<&[u8]>, epoch: u64) -> [u8; SEED_BYTE_LEN] {
    match master_secret {
        Some(secret) => {
            let mut hasher = Sha256::new();
            hasher.update(b"nyx-pir-v1");
            hasher.update((secret.len() as u64).to_be_bytes());
            hasher.update(secret);
            hasher.update(epoch.to_be_bytes());
            hasher.finalize().into()
        }
        None => {
            let mut seed = [0u8; SEED_BYTE_LEN];
            rand::rng().fill_bytes(&mut seed);
            seed
        }
    }
}

pub fn build_index(
    snapshot: ValidatedSnapshot,
    master_secret: Option<&[u8]>,
    arity: u32,
) -> Result<PirIndex> {
    let epoch = snapshot.epoch;
    let record_bytes = snapshot.record_bytes;
    let entry_count = snapshot.entries.len();
    let seed = derive_seed(master_secret, epoch);

    let mut db: HashMap<&[u8], &[u8]> = HashMap::with_capacity(entry_count);
    for entry in &snapshot.entries {
        if db
            .insert(entry.oprf.as_slice(), entry.value.as_slice())
            .is_some()
        {
            bail!("index OPRF duplikat setelah validasi");
        }
    }

    let (server, hint, filter) = match arity {
        3 => Server::setup::<3>(&seed, db).context("ChalametPIR setup arity 3 gagal")?,
        4 => Server::setup::<4>(&seed, db).context("ChalametPIR setup arity 4 gagal")?,
        other => bail!("arity harus 3 atau 4 (didapat {other})"),
    };

    let payload = ParamsPayload {
        epoch,
        record_bytes,
        entry_count,
        suite: SUITE,
        arity,
        seed: BASE64URL_NOPAD.encode(&seed),
        hint: BASE64URL_NOPAD.encode(&hint),
        filter: BASE64URL_NOPAD.encode(&filter),
    };
    let params = serde_json::to_vec(&payload).context("serialisasi /params gagal")?;

    Ok(PirIndex {
        server,
        epoch,
        record_bytes,
        entry_count,
        seed,
        hint,
        filter,
        arity,
        params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_is_stable_per_epoch_and_secret() {
        let a = derive_seed(Some(b"master"), 1);
        let b = derive_seed(Some(b"master"), 1);
        let c = derive_seed(Some(b"master"), 2);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
