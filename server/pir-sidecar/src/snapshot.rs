// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! Snapshot validation for the PIR directory.
//!
//! The snapshot is produced offline by `server/scripts/build-pir-snapshot.ts`.
//! It is deliberately strict: every `oprf` is a 32-byte OPRF index and every
//! value is exactly `recordBytes` long, so a malformed epoch cannot silently
//! change the shape of the PIR database.

use std::collections::HashSet;

use anyhow::{Result, anyhow, bail};
use data_encoding::BASE64URL_NOPAD;
use serde::{Deserialize, Serialize};

pub const INDEX_BYTES: usize = 32;
pub const MIN_RECORD_BYTES: usize = 256;
pub const MAX_RECORD_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: u64,
    pub record_bytes: usize,
    pub entries: Vec<SnapshotEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SnapshotEntry {
    /// Base64url (no padding) of the 32-byte OPRF index.
    pub oprf: String,
    /// Base64url (no padding) of the exact `recordBytes` record.
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct ValidatedEntry {
    pub oprf: [u8; INDEX_BYTES],
    pub value: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ValidatedSnapshot {
    pub epoch: u64,
    pub record_bytes: usize,
    pub entries: Vec<ValidatedEntry>,
}

fn decode_canonical(field: &str, encoded: &str) -> Result<Vec<u8>> {
    let bytes = BASE64URL_NOPAD
        .decode(encoded.as_bytes())
        .map_err(|_| anyhow!("{field} bukan base64url tanpa padding yang valid"))?;
    if BASE64URL_NOPAD.encode(&bytes) != encoded {
        bail!("{field} bukan base64url kanonik");
    }
    Ok(bytes)
}

impl Snapshot {
    /// Validate shape, index/value lengths, uniqueness, and bounds.
    pub fn validate(self, max_entries: usize) -> Result<ValidatedSnapshot> {
        if self.epoch == 0 {
            bail!("epoch harus > 0");
        }
        if !(MIN_RECORD_BYTES..=MAX_RECORD_BYTES).contains(&self.record_bytes) {
            bail!(
                "recordBytes harus di antara {} dan {} (didapat {})",
                MIN_RECORD_BYTES,
                MAX_RECORD_BYTES,
                self.record_bytes
            );
        }
        if self.entries.is_empty() {
            bail!("snapshot tidak boleh kosong");
        }
        if self.entries.len() > max_entries {
            bail!(
                "snapshot berisi {} entri, melebihi batas {}",
                self.entries.len(),
                max_entries
            );
        }

        let mut seen: HashSet<[u8; INDEX_BYTES]> = HashSet::with_capacity(self.entries.len());
        let mut entries = Vec::with_capacity(self.entries.len());
        for (index, entry) in self.entries.into_iter().enumerate() {
            let oprf_bytes = decode_canonical(&format!("entries[{index}].oprf"), &entry.oprf)?;
            let oprf: [u8; INDEX_BYTES] = oprf_bytes
                .try_into()
                .map_err(|_| anyhow!("entries[{index}].oprf harus tepat {INDEX_BYTES} byte"))?;
            if !seen.insert(oprf) {
                bail!("entries[{index}].oprf duplikat");
            }
            let value = decode_canonical(&format!("entries[{index}].value"), &entry.value)?;
            if value.len() != self.record_bytes {
                bail!(
                    "entries[{index}].value harus tepat {} byte (didapat {})",
                    self.record_bytes,
                    value.len()
                );
            }
            entries.push(ValidatedEntry { oprf, value });
        }

        Ok(ValidatedSnapshot {
            epoch: self.epoch,
            record_bytes: self.record_bytes,
            entries,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(oprf: u8, len: usize) -> SnapshotEntry {
        SnapshotEntry {
            oprf: BASE64URL_NOPAD.encode(&[oprf; INDEX_BYTES]),
            value: BASE64URL_NOPAD.encode(&vec![oprf; len]),
        }
    }

    fn snapshot(entries: Vec<SnapshotEntry>, record_bytes: usize) -> Snapshot {
        Snapshot {
            epoch: 1,
            record_bytes,
            entries,
        }
    }

    #[test]
    fn accepts_canonical_snapshot() {
        let validated = snapshot(vec![entry(1, 256), entry(2, 256)], 256)
            .validate(10)
            .unwrap();
        assert_eq!(validated.entries.len(), 2);
        assert_eq!(validated.record_bytes, 256);
    }

    #[test]
    fn rejects_duplicate_index() {
        let err = snapshot(vec![entry(1, 256), entry(1, 256)], 256)
            .validate(10)
            .unwrap_err();
        assert!(err.to_string().contains("duplikat"));
    }

    #[test]
    fn rejects_wrong_value_length() {
        let err = snapshot(vec![entry(1, 255)], 256).validate(10).unwrap_err();
        assert!(err.to_string().contains("tepat 256 byte"));
    }

    #[test]
    fn rejects_invalid_base64() {
        let mut e = entry(1, 256);
        e.oprf.push('=');
        let err = snapshot(vec![e], 256).validate(10).unwrap_err();
        assert!(err.to_string().contains("base64url"));
    }

    #[test]
    fn rejects_empty_and_oversized_snapshots() {
        assert!(snapshot(vec![], 256).validate(10).is_err());
        assert!(snapshot(vec![entry(1, 256)], 256).validate(0).is_err());
    }

    #[test]
    fn rejects_bad_record_bounds() {
        assert!(snapshot(vec![entry(1, 255)], 255).validate(10).is_err());
        assert!(
            snapshot(vec![entry(1, MAX_RECORD_BYTES + 1)], MAX_RECORD_BYTES + 1)
                .validate(10)
                .is_err()
        );
    }
}
