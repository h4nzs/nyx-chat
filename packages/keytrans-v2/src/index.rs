//
// Copyright 2026 NYX contributors.
// SPDX-License-Identifier: AGPL-3.0-only
//
//! Public index derivation for KT v2.
//!
//! v1 indexed log entries by an ECVRF output. v2 removes the VRF: the index
//! is `SHA-256("nyx-kt-v2-index" || search_key)`, identical to the Go service
//! (`server/kt-query/v2/transparency/crypto.go`).

use sha2::{Digest, Sha256};

/// Domain separator prefixed to every search key.
pub const INDEX_DOMAIN: &[u8] = b"nyx-kt-v2-index";

/// Derive the 32-byte prefix-tree index for a search key.
pub fn index(search_key: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(INDEX_DOMAIN);
    hasher.update(search_key);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_domain_separated() {
        let key = b"\x75\x01\x02";
        let got = index(key);
        let bare = Sha256::digest(key);
        assert_ne!(got.as_slice(), bare.as_slice());
        assert_eq!(got, index(key));
        assert_ne!(got, index(b"\x75\x01\x03"));
    }
}
