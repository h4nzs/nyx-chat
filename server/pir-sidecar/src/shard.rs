// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/42 WP3] Satu shard XOR-PIR: validasi artefak + hot-swap per shard.
//!
//! Sidecar tidak memverifikasi tanda tangan manifest (itu tugas klien di
//! WP6 — sidecar tidak memegang kunci publik yang di-pin), tetapi ia **wajib**
//! memeriksa bahwa berkas slot benar-benar cocok dengan `dbRoot` di manifest.
//! Tanpa pemeriksaan itu, operator yang salah menaruh berkas akan menyajikan
//! data basi dengan label epoch baru dan klien tidak bisa membedakannya.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result, bail};
use data_encoding::HEXLOWER;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::pir::{answer, share_len};

pub const MIN_RECORD_BYTES: usize = 256;
pub const MAX_RECORD_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub suite: String,
    pub shard: u32,
    pub shard_count: u32,
    pub slot_count: u32,
    pub record_bytes: u32,
    pub epoch: u64,
    pub entry_count: u32,
    pub db_root: String,
    pub operator: String,
    pub key_id: String,
}

/// Format berkas yang ditulis `serializePirShard` (WP2).
#[derive(Debug, Deserialize)]
pub struct ShardFile {
    pub manifest: Manifest,
    pub signature: String,
}

#[derive(Debug)]
pub struct Shard {
    pub manifest: Manifest,
    pub signature: String,
    slots: Vec<u8>,
}

impl Shard {
    pub fn from_parts(file: ShardFile, slots: Vec<u8>) -> Result<Self> {
        validate_manifest(&file.manifest, slots.len())?;
        let expected = db_root(&slots, file.manifest.record_bytes as usize);
        if expected != file.manifest.db_root {
            bail!(
                "PIR: dbRoot manifest {} tidak cocok dengan isi slot {}",
                file.manifest.db_root,
                expected
            );
        }
        Ok(Self {
            manifest: file.manifest,
            signature: file.signature,
            slots,
        })
    }

    pub fn from_files(bin_path: &Path, manifest_path: &Path) -> Result<Self> {
        let slots = std::fs::read(bin_path)
            .with_context(|| format!("gagal membaca slot {}", bin_path.display()))?;
        let raw = std::fs::read(manifest_path)
            .with_context(|| format!("gagal membaca manifest {}", manifest_path.display()))?;
        let file: ShardFile = serde_json::from_slice(&raw)
            .with_context(|| format!("manifest {} bukan JSON valid", manifest_path.display()))?;
        Self::from_parts(file, slots)
    }

    pub fn slot_count(&self) -> usize {
        self.manifest.slot_count as usize
    }

    pub fn record_bytes(&self) -> usize {
        self.manifest.record_bytes as usize
    }

    pub fn answer(&self, share: &[u8]) -> Result<Vec<u8>> {
        answer(&self.slots, self.record_bytes(), share)
    }

    pub fn share_len(&self) -> usize {
        share_len(self.slot_count())
    }
}

fn validate_manifest(manifest: &Manifest, slot_bytes: usize) -> Result<()> {
    if manifest.suite != crate::pir::SUITE {
        bail!(
            "PIR: suite {} tidak didukung (harus {})",
            manifest.suite,
            crate::pir::SUITE
        );
    }
    if manifest.shard_count == 0 || manifest.shard >= manifest.shard_count {
        bail!(
            "PIR: shard {} di luar shardCount {}",
            manifest.shard,
            manifest.shard_count
        );
    }
    let slot_count = manifest.slot_count as usize;
    if slot_count < 4 || !slot_count.is_power_of_two() {
        bail!("PIR: slotCount harus pangkat dua >= 4 (didapat {slot_count})");
    }
    let record_bytes = manifest.record_bytes as usize;
    if !(MIN_RECORD_BYTES..=MAX_RECORD_BYTES).contains(&record_bytes) {
        bail!(
            "PIR: recordBytes harus {MIN_RECORD_BYTES}..{MAX_RECORD_BYTES} (didapat {record_bytes})"
        );
    }
    if slot_bytes != slot_count * record_bytes {
        bail!(
            "PIR: ukuran slot {slot_bytes} byte bukan slotCount*recordBytes ({} byte)",
            slot_count * record_bytes
        );
    }
    if manifest.entry_count as usize > slot_count / 2 {
        bail!(
            "PIR: entryCount {} melebihi kapasitas 50% ({})",
            manifest.entry_count,
            slot_count / 2
        );
    }
    if manifest.epoch == 0 {
        bail!("PIR: epoch harus > 0");
    }
    if !is_hex64(&manifest.db_root) {
        bail!("PIR: dbRoot harus 32 byte hex huruf kecil");
    }
    if !is_hex64(&manifest.key_id) {
        bail!("PIR: keyId harus 32 byte hex huruf kecil");
    }
    if manifest.operator.is_empty() || manifest.operator.len() > 64 {
        bail!("PIR: operator harus 1..64 karakter");
    }
    Ok(())
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// `sha256(recordBytes BE u32 || seluruh slot)` — identik dengan `pirDbRoot()`
/// di `@nyx/shared`.
pub fn db_root(slots: &[u8], record_bytes: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update((record_bytes as u32).to_be_bytes());
    hasher.update(slots);
    HEXLOWER.encode(&hasher.finalize())
}

/// Kegagalan `install` yang punya kode HTTP sendiri (409 di WP4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallError {
    ShardCountMismatch,
    EpochStale,
    EpochConflict,
}

impl InstallError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ShardCountMismatch => "PIR_SHARD_COUNT_MISMATCH",
            Self::EpochStale => "PIR_EPOCH_STALE",
            Self::EpochConflict => "PIR_EPOCH_CONFLICT",
        }
    }
}

#[derive(Default)]
struct State {
    shards: HashMap<u32, Arc<Shard>>,
    shard_count: Option<u32>,
    epoch: u64,
}

/// Kumpulan shard yang bisa di-hot-swap satu per satu.
#[derive(Default)]
pub struct ShardSet {
    state: RwLock<State>,
}

impl ShardSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Pasang satu shard. Hanya gagal pada invarian global; isi artefak sudah
    /// divalidasi di `Shard::from_parts`.
    pub fn install(&self, shard: Shard) -> Result<Arc<Shard>, InstallError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(count) = state.shard_count {
            if count != shard.manifest.shard_count {
                return Err(InstallError::ShardCountMismatch);
            }
        }
        if let Some(existing) = state.shards.get(&shard.manifest.shard) {
            if shard.manifest.epoch < existing.manifest.epoch {
                return Err(InstallError::EpochStale);
            }
            if shard.manifest.epoch == existing.manifest.epoch
                && shard.manifest.db_root != existing.manifest.db_root
            {
                return Err(InstallError::EpochConflict);
            }
        }

        let installed = Arc::new(shard);
        state.epoch = state.epoch.max(installed.manifest.epoch);
        state.shard_count = Some(installed.manifest.shard_count);
        state
            .shards
            .insert(installed.manifest.shard, Arc::clone(&installed));
        Ok(installed)
    }

    pub fn get(&self, shard: u32) -> Option<Arc<Shard>> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        state.shards.get(&shard).cloned()
    }

    pub fn shard_count(&self) -> Option<u32> {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .shard_count
    }

    pub fn epoch(&self) -> u64 {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .epoch
    }

    pub fn installed(&self) -> usize {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .shards
            .len()
    }

    /// Total entri di semua shard yang termuat (untuk `/health`).
    pub fn entry_count(&self) -> usize {
        self.state
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .shards
            .values()
            .map(|shard| shard.manifest.entry_count as usize)
            .sum()
    }

    pub fn answer(&self, shard: u32, share: &[u8]) -> Result<Vec<u8>> {
        let shard = self
            .get(shard)
            .with_context(|| format!("PIR_SHARD_UNKNOWN: shard {shard} belum dimuat"))?;
        shard.answer(share)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_for(slot_count: u32, record_bytes: u32, slots: &[u8]) -> Manifest {
        Manifest {
            suite: crate::pir::SUITE.to_string(),
            shard: 0,
            shard_count: 1,
            slot_count,
            record_bytes,
            epoch: 1,
            entry_count: 1,
            db_root: db_root(slots, record_bytes as usize),
            operator: "nyx-a".to_string(),
            key_id: "a".repeat(64),
        }
    }

    fn slots_fixture(slot_count: usize, record_bytes: usize) -> Vec<u8> {
        (0..slot_count)
            .flat_map(|slot| {
                (0..record_bytes).map(move |byte| (slot as u8).wrapping_mul(7) ^ byte as u8)
            })
            .collect()
    }

    fn shard_fixture() -> Shard {
        let slots = slots_fixture(64, 256);
        let manifest = manifest_for(64, 256, &slots);
        Shard::from_parts(
            ShardFile {
                manifest,
                signature: "sig".to_string(),
            },
            slots,
        )
        .expect("shard valid")
    }

    #[test]
    fn recovers_record_through_two_shares() {
        let shard = shard_fixture();
        let mut q1 = vec![0u8; shard.share_len()];
        rand::fill(&mut q1[..]);
        let mut q2 = q1.clone();
        crate::pir::toggle(&mut q2, 21);

        let a1 = shard.answer(&q1).expect("answer 1");
        let a2 = shard.answer(&q2).expect("answer 2");
        let recovered: Vec<u8> = a1.iter().zip(&a2).map(|(a, b)| a ^ b).collect();
        let slot = &shard.slots[21 * 256..22 * 256];
        assert_eq!(recovered, slot);
    }

    #[test]
    fn rejects_manifest_that_does_not_match_slots() {
        let slots = slots_fixture(64, 256);
        let mut manifest = manifest_for(64, 256, &slots);
        manifest.db_root = "b".repeat(64);
        let error = Shard::from_parts(
            ShardFile {
                manifest,
                signature: "s".into(),
            },
            slots,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("dbRoot"));
    }

    #[test]
    fn rejects_structurally_invalid_manifests() {
        let slots = slots_fixture(64, 256);
        let cases: [fn(&mut Manifest); 9] = [
            |m| m.suite = "chalametpir-v1".into(),
            |m| m.shard = 1,
            |m| m.slot_count = 63,
            |m| m.record_bytes = 128,
            |m| m.entry_count = 33,
            |m| m.epoch = 0,
            |m| m.db_root = "XYZ".into(),
            |m| m.key_id = "A".repeat(64),
            |m| m.operator = String::new(),
        ];
        for mutate in cases {
            let mut manifest = manifest_for(64, 256, &slots);
            mutate(&mut manifest);
            assert!(
                Shard::from_parts(
                    ShardFile {
                        manifest,
                        signature: "s".into()
                    },
                    slots_fixture(64, 256)
                )
                .is_err(),
                "manifest cacat seharusnya ditolak"
            );
        }
    }

    #[test]
    fn rejects_slot_bytes_with_wrong_size() {
        let slots = slots_fixture(64, 256);
        let manifest = manifest_for(64, 256, &slots);
        assert!(
            Shard::from_parts(
                ShardFile {
                    manifest,
                    signature: "s".into()
                },
                slots[..100].to_vec()
            )
            .is_err()
        );
    }

    fn shard_of(manifest: Manifest, slots: Vec<u8>) -> Shard {
        Shard::from_parts(
            ShardFile {
                manifest,
                signature: "s".into(),
            },
            slots,
        )
        .expect("shard valid")
    }

    #[test]
    fn install_is_monotonic_per_shard_and_shard_count_is_global() {
        let set = ShardSet::new();
        set.install(shard_fixture()).expect("install pertama");
        assert_eq!(set.installed(), 1);
        assert_eq!(set.epoch(), 1);

        // epoch sama, isi sama = idempoten.
        set.install(shard_fixture()).expect("install ulang");

        // epoch lebih kecil untuk shard yang sama ditolak.
        let same_slots = slots_fixture(64, 256);
        let base = manifest_for(64, 256, &same_slots);
        let mut bumped = base.clone();
        bumped.epoch = 2;
        set.install(shard_of(bumped, same_slots.clone()))
            .expect("epoch naik");
        let error = set
            .install(shard_of(base.clone(), same_slots.clone()))
            .unwrap_err();
        assert_eq!(error, InstallError::EpochStale);

        // epoch sama tetapi isi berbeda ditolak (tidak jelas mana yang benar).
        let mut conflicting = slots_fixture(64, 256);
        conflicting[0] ^= 0xff;
        let mut same_epoch = manifest_for(64, 256, &conflicting);
        same_epoch.epoch = 2;
        let error = set.install(shard_of(same_epoch, conflicting)).unwrap_err();
        assert_eq!(error, InstallError::EpochConflict);

        // shardCount global tidak boleh berubah di tengah jalan.
        let cross_slots = slots_fixture(64, 256);
        let mut cross = manifest_for(64, 256, &cross_slots);
        cross.shard = 1;
        cross.shard_count = 2;
        cross.epoch = 3;
        let error = set.install(shard_of(cross, cross_slots)).unwrap_err();
        assert_eq!(error, InstallError::ShardCountMismatch);
    }

    #[test]
    fn answer_unknown_shard_is_an_error() {
        let set = ShardSet::new();
        let error = set.answer(9, &[0u8; 8]).unwrap_err().to_string();
        assert!(error.contains("PIR_SHARD_UNKNOWN"));
    }

    #[test]
    fn loads_from_files_written_like_wp2() {
        let dir = std::env::temp_dir().join(format!("nyx-pir-shard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let slots = slots_fixture(32, 256);
        let manifest = manifest_for(32, 256, &slots);
        let bin = dir.join("shard-0.bin");
        let json = dir.join("shard-0.json");
        std::fs::write(&bin, &slots).unwrap();
        std::fs::write(
            &json,
            serde_json::to_vec(&serde_json::json!({ "manifest": manifest, "signature": "sig" }))
                .unwrap(),
        )
        .unwrap();

        let shard = Shard::from_files(&bin, &json).expect("load");
        assert_eq!(shard.slot_count(), 32);
        assert_eq!(shard.record_bytes(), 256);
        assert_eq!(shard.share_len(), 4);

        // Satu byte dibalik di berkas bin = dbRoot tidak cocok.
        let mut tampered = slots.clone();
        tampered[5] ^= 0x01;
        std::fs::write(&bin, &tampered).unwrap();
        assert!(Shard::from_files(&bin, &json).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
