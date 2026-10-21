//
// Copyright 2026 NYX contributors.
// SPDX-License-Identifier: AGPL-3.0-only
//
//! ML-DSA-65 verifying keys for KT v2 tree heads.
//!
//! The upstream crate used `ed25519_dalek::VerifyingKey` directly. In v2 the
//! signature key is an ML-DSA-65 public key (1952 bytes) and signatures are
//! 3309 bytes. The encoded public key is kept alongside the decoded key so
//! `as_bytes()` can return it without re-encoding on every comparison.

use ml_dsa::{
    EncodedSignature, EncodedVerifyingKey, MlDsa65, Signature, VerifyingKey as MlDsaVerifyingKey,
};

use crate::Error;

/// Encoded size of an ML-DSA-65 public key.
pub const ML_DSA_65_PUBLIC_KEY_SIZE: usize = 1952;
/// Encoded size of an ML-DSA-65 signature.
pub const ML_DSA_65_SIGNATURE_SIZE: usize = 3309;

/// ML-DSA external context for service tree heads.
pub const HEAD_CONTEXT: &[u8] = b"NYX-KT-V2-HEAD";
/// ML-DSA external context for auditor tree heads.
pub const AUDITOR_CONTEXT: &[u8] = b"NYX-KT-V2-AUDITOR";

/// An ML-DSA-65 public key used to authenticate a KT v2 tree head.
#[derive(Clone, PartialEq)]
pub struct VerifyingKey {
    encoded: Box<[u8]>,
    key: MlDsaVerifyingKey<MlDsa65>,
}

impl std::fmt::Debug for VerifyingKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifyingKey")
            .field("encoded", &hex::encode(&self.encoded))
            .finish()
    }
}

impl VerifyingKey {
    /// Decode an ML-DSA-65 public key from its FIPS 204 encoding.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let encoded = EncodedVerifyingKey::<MlDsa65>::try_from(bytes)
            .map_err(|_| Error::BadData("ML-DSA public key has wrong size".to_string()))?;
        Ok(Self {
            encoded: bytes.into(),
            key: MlDsaVerifyingKey::decode(&encoded),
        })
    }

    /// The encoded public key, as used by the signed tree head.
    pub fn as_bytes(&self) -> &[u8] {
        &self.encoded
    }

    /// Verify an ML-DSA-65 signature over `message` with the given context.
    pub fn verify(&self, message: &[u8], signature: &[u8], context: &[u8]) -> bool {
        let Ok(encoded) = EncodedSignature::<MlDsa65>::try_from(signature) else {
            return false;
        };
        let Some(signature) = Signature::<MlDsa65>::decode(&encoded) else {
            return false;
        };
        self.key.verify_with_context(message, context, &signature)
    }
}
