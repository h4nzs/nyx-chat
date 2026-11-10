// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/42 WP3] Primitive XOR-PIR.
//!
//! Satu shard = `S` slot, tiap slot `R` byte. Klien mengirim share berupa
//! vektor bit `S` bit; server menjawab `⊕ { slot[j] : share[j] = 1 }`. Dua share
//! yang XOR-nya `e_i` menghasilkan `slot[i]` saat jawabannya di-XOR.
//!
//! Urutan bit: **LSB-first dalam tiap byte** (bit `j` = `share[j/8] >> (j%8)`).
//! Bit di luar `S` diabaikan, jadi klien boleh mengirim byte acak penuh tanpa
//! membuat query ditolak.

use anyhow::{Result, bail};

pub const SUITE: &str = "xor-pir-v1";

/// Panjang share untuk `slot_count` slot: `ceil(S/8)` byte.
pub fn share_len(slot_count: usize) -> usize {
    slot_count.div_ceil(8)
}

#[inline]
pub fn share_bit(share: &[u8], bit: usize) -> bool {
    share[bit / 8] & (1 << (bit % 8)) != 0
}

/// Jawab satu share. Panjang share harus sama dengan `share_len(slot_count)`.
pub fn answer(slots: &[u8], record_bytes: usize, share: &[u8]) -> Result<Vec<u8>> {
    if record_bytes == 0 {
        bail!("PIR: record_bytes harus > 0");
    }
    if slots.len() % record_bytes != 0 {
        bail!("PIR: ukuran slot array bukan kelipatan record_bytes");
    }
    let slot_count = slots.len() / record_bytes;
    if share.len() != share_len(slot_count) {
        bail!(
            "PIR: share harus {} byte untuk {} slot",
            share_len(slot_count),
            slot_count
        );
    }

    let mut out = vec![0u8; record_bytes];
    for (slot, record) in slots.chunks_exact(record_bytes).enumerate() {
        if share_bit(share, slot) {
            xor_in_place(&mut out, record);
        }
    }
    Ok(out)
}

#[inline]
fn xor_in_place(dst: &mut [u8], src: &[u8]) {
    debug_assert_eq!(dst.len(), src.len());
    for (target, byte) in dst.iter_mut().zip(src) {
        *target ^= byte;
    }
}

/// `q2 = q1 ⊕ e_i` — dipakai tes dan (nanti) vektor lintas-implementasi.
pub fn toggle(share: &mut [u8], slot: usize) {
    share[slot / 8] ^= 1 << (slot % 8);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slots(count: usize, record_bytes: usize) -> Vec<u8> {
        (0..count)
            .flat_map(|slot| (0..record_bytes).map(move |byte| (slot as u8) ^ (byte as u8)))
            .collect()
    }

    #[test]
    fn share_len_matches_gate() {
        assert_eq!(share_len(4096), 512);
        assert_eq!(share_len(1), 1);
        assert_eq!(share_len(9), 2);
    }

    #[test]
    fn two_shares_recover_the_record() {
        let records = slots(64, 256);
        let mut q1 = vec![0u8; share_len(64)];
        rand::fill(&mut q1[..]);
        let mut q2 = q1.clone();
        toggle(&mut q2, 37);

        let a1 = answer(&records, 256, &q1).expect("answer 1");
        let a2 = answer(&records, 256, &q2).expect("answer 2");
        let mut recovered = a1;
        xor_in_place(&mut recovered, &a2);

        let expected = &records[37 * 256..38 * 256];
        assert_eq!(recovered, expected);
    }

    #[test]
    fn zero_share_answers_zero() {
        let records = slots(16, 256);
        let zeros = vec![0u8; share_len(16)];
        assert_eq!(answer(&records, 256, &zeros).unwrap(), vec![0u8; 256]);
    }

    #[test]
    fn rejects_wrong_share_length() {
        let records = slots(16, 256);
        let error = answer(&records, 256, &[0u8; 1]).unwrap_err().to_string();
        assert!(error.contains("share harus"));
        assert!(answer(&records, 0, &[0u8; 2]).is_err());
        assert!(answer(&records[..250], 256, &[0u8; 2]).is_err());
    }

    #[test]
    fn bits_beyond_slot_count_are_ignored() {
        let records = slots(3, 256);
        let mut share = vec![0xffu8; share_len(3)];
        // Bit 0..3 saja yang berarti; sisanya harus diabaikan, bukan ditolak.
        share[0] = 0b0000_0001;
        assert_eq!(answer(&records, 256, &share).unwrap(), &records[..256]);
    }

    /// [docs/42 WP8] Fixture yang sama dibaca tes TypeScript
    /// (`server/tests/pirVectors.test.ts`). Record di sini dibangun ulang dari
    /// layout v2, bukan dari kode Rust produksi — yang diuji adalah apakah
    /// urutan bit, XOR, dan padding kedua implementasi benar-benar sama.
    #[test]
    fn cross_impl_vectors_match_fixture() {
        use data_encoding::{BASE64URL_NOPAD, HEXLOWER_PERMISSIVE};
        use sha2::{Digest, Sha256};

        let raw = include_str!("../../tests/fixtures/pirVectors.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture JSON");
        let slot_count = fixture["slotCount"].as_u64().expect("slotCount") as usize;
        let record_bytes = fixture["recordBytes"].as_u64().expect("recordBytes") as usize;
        let index = HEXLOWER_PERMISSIVE
            .decode(fixture["oprfIndexHex"].as_str().expect("index").as_bytes())
            .expect("index hex");
        let body = BASE64URL_NOPAD
            .decode(fixture["bodyBase64url"].as_str().expect("body").as_bytes())
            .expect("body base64url");
        let share = HEXLOWER_PERMISSIVE
            .decode(fixture["shareHex"].as_str().expect("share").as_bytes())
            .expect("share hex");
        let q2 = HEXLOWER_PERMISSIVE
            .decode(fixture["q2Hex"].as_str().expect("q2").as_bytes())
            .expect("q2 hex");
        let candidate = fixture["candidates"][0].as_u64().expect("candidate") as usize;

        let mut record = vec![0u8; record_bytes];
        record[0] = 2;
        let mut ix = Sha256::new();
        ix.update(b"nyx:pir:record-index:v1\0");
        ix.update(&index);
        record[1..33].copy_from_slice(&ix.finalize());
        record[33] = (body.len() >> 8) as u8;
        record[34] = body.len() as u8;
        record[35..35 + body.len()].copy_from_slice(&body);
        let mut tag = Sha256::new();
        tag.update(&record[..record_bytes - 16]);
        record[record_bytes - 16..].copy_from_slice(&tag.finalize()[..16]);

        let mut slots = vec![0u8; slot_count * record_bytes];
        for slot in 0..slot_count {
            for byte in 0..record_bytes {
                slots[slot * record_bytes + byte] = ((slot * 31 + byte * 7) & 0xff) as u8;
            }
        }
        slots[candidate * record_bytes..(candidate + 1) * record_bytes].copy_from_slice(&record);

        let a1 = answer(&slots, record_bytes, &share).expect("answer 1");
        let a2 = answer(&slots, record_bytes, &q2).expect("answer 2");
        let digest = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
        assert_eq!(digest(&a1), fixture["answerQ1Sha256"].as_str().unwrap());
        assert_eq!(digest(&a2), fixture["answerQ2Sha256"].as_str().unwrap());

        let mut recovered = a1;
        xor_in_place(&mut recovered, &a2);
        assert_eq!(
            digest(&recovered),
            fixture["recordSha256"].as_str().unwrap()
        );
        assert_eq!(recovered, record);

        let mut toggled = share.clone();
        toggle(&mut toggled, candidate);
        assert_eq!(toggled, q2);
    }
}
