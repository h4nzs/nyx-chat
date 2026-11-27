// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
//
// Generator vektor lintas implementasi untuk OHTTP + HPKE X-Wing.
//
// Ini SENGAJA bukan pustaka crypto NYX: ia memakai `hpke` Rust 0.15.2
// (rozbb/rust-hpke) untuk menghasilkan Encapsulated Request yang harus bisa
// dibuka oleh `decapsulateOhttpRequest` di `packages/shared`. Kalau kedua
// implementasi salah dengan cara yang sama, round-trip internal tidak akan
// menangkapnya — vektor ini yang menangkapnya.
//
// Jalankan dari akar repo:
//   cargo run --quiet --manifest-path tools/hpke-xwing-vector/Cargo.toml \
//     > server/tests/fixtures/hpke-xwing-ohttp.json
//
// Nilai seed/randomness sengaja tetap dan dicetak di JSON. Jangan mengubahnya
// tanpa meregenerasi vektor + menjalankan `server/tests/ohttp.test.ts`.
use hpke::{
    Kem as _, OpModeS, Serializable, aead::AesGcm256, kdf::HkdfSha256, kem::XWing,
    setup_sender_with_rng,
};
use rand_core::{Infallible, TryCryptoRng, TryRng};

const KEY_ID: u8 = 3;
const KEM_ID: u16 = 0x647a;
const KDF_ID: u16 = 0x0001;
const AEAD_ID: u16 = 0x0002;
const KEY_SEED: [u8; 32] = [0x42; 32];
const RNG_SEED: u64 = 0x4e59582d_5857494e; // "NYX-XWIN"

/// PRNG deterministik; hanya untuk generator vektor, bukan runtime.
struct FixedRng {
    state: u64,
}

impl FixedRng {
    fn next(&mut self) -> u64 {
        // xorshift64*: cukup untuk reproducible bytes, bukan untuk keamanan.
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

impl TryRng for FixedRng {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        Ok(self.next() as u32)
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        Ok(self.next())
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        for chunk in dst.chunks_mut(8) {
            let word = self.next().to_le_bytes();
            chunk.copy_from_slice(&word[..chunk.len()]);
        }
        Ok(())
    }
}

impl TryCryptoRng for FixedRng {}

/// Memberi kembali byte yang sudah ditentukan; dipakai agar `ekm` yang dicetak
/// benar-benar byte yang dikonsumsi `setup_sender_with_rng`.
struct ReplayRng {
    bytes: [u8; 64],
    offset: usize,
}

impl TryRng for ReplayRng {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut buf = [0u8; 4];
        self.try_fill_bytes(&mut buf)?;
        Ok(u32::from_le_bytes(buf))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut buf = [0u8; 8];
        self.try_fill_bytes(&mut buf)?;
        Ok(u64::from_le_bytes(buf))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        let end = self.offset + dst.len();
        dst.copy_from_slice(&self.bytes[self.offset..end]);
        self.offset = end;
        Ok(())
    }
}

impl TryCryptoRng for ReplayRng {}

fn varint(value: usize) -> Vec<u8> {
    assert!(value < 0x40);
    vec![value as u8]
}

fn length_prefixed(bytes: &[u8]) -> Vec<u8> {
    let mut out = varint(bytes.len());
    out.extend_from_slice(bytes);
    out
}

/// Binary HTTP known-length request (RFC 9292, framing indicator 0), bentuk
/// yang sama dengan `encodeBinaryHttpRequest` di packages/shared.
fn binary_http_request() -> Vec<u8> {
    let method = b"GET";
    let scheme = b"https";
    let authority = b"nyx-app.my.id";
    let path = b"/api/users/search?q=xwing-vector";
    let mut fields = Vec::new();
    fields.extend(length_prefixed(b"accept"));
    fields.extend(length_prefixed(b"application/json"));

    let mut out = varint(0);
    out.extend(length_prefixed(method));
    out.extend(length_prefixed(scheme));
    out.extend(length_prefixed(authority));
    out.extend(length_prefixed(path));
    out.extend(varint(fields.len()));
    out.extend(fields);
    out.extend(varint(0)); // content kosong
    out.extend(varint(0)); // trailer kosong
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn main() {
    let (private_key, public_key) = XWing::derive_keypair(&KEY_SEED);
    let header = [
        KEY_ID,
        (KEM_ID >> 8) as u8,
        KEM_ID as u8,
        (KDF_ID >> 8) as u8,
        KDF_ID as u8,
        (AEAD_ID >> 8) as u8,
        AEAD_ID as u8,
    ];
    let mut info = b"message/bhttp request".to_vec();
    info.push(0);
    info.extend_from_slice(&header);

    let mut seed_rng = FixedRng { state: RNG_SEED };
    let mut encapsulation_randomness = [0u8; 64];
    seed_rng
        .try_fill_bytes(&mut encapsulation_randomness)
        .expect("deterministic RNG");
    let mut rng = ReplayRng {
        bytes: encapsulation_randomness,
        offset: 0,
    };
    let (enc, mut context) = setup_sender_with_rng::<AesGcm256, HkdfSha256, XWing>(
        &OpModeS::Base,
        &public_key,
        &info,
        &mut rng,
    )
    .expect("X-Wing encapsulation");
    let plaintext = binary_http_request();
    let ciphertext = context.seal(&plaintext, &[]).expect("HPKE seal");

    let mut encapsulated_request = header.to_vec();
    encapsulated_request.extend_from_slice(&enc.to_bytes());
    encapsulated_request.extend_from_slice(&ciphertext);

    // Public key sengaja tidak diikutkan: test memakai private key + body,
    // persis seperti gateway. Public key hanya berguna saat meregenerasi.
    println!("{{");
    println!(
        "  \"provenance\": \"rust-hpke 0.15.2 (XWing, HKDF-SHA256, AES-256-GCM), generated by tools/hpke-xwing-vector\","
    );
    println!("  \"keySeed\": \"{}\",", hex(&KEY_SEED));
    println!("  \"rngSeed\": \"{RNG_SEED:016x}\",");
    println!("  \"keyId\": {KEY_ID},");
    println!("  \"kemId\": {KEM_ID},");
    println!("  \"kdfId\": {KDF_ID},");
    println!("  \"aeadId\": {AEAD_ID},");
    println!("  \"privateKey\": \"{}\",", hex(&private_key.to_bytes()));
    println!(
        "  \"encapsulationRandomness\": \"{}\",",
        hex(&encapsulation_randomness)
    );
    println!("  \"publicKey\": \"{}\",", hex(&public_key.to_bytes()));
    println!("  \"enc\": \"{}\",", hex(&enc.to_bytes()));
    println!("  \"plaintext\": \"{}\",", hex(&plaintext));
    println!("  \"ciphertext\": \"{}\",", hex(&ciphertext));
    println!(
        "  \"encapsulatedRequest\": \"{}\"",
        hex(&encapsulated_request)
    );
    println!("}}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use hpke::{Deserializable, OpModeR, setup_receiver};

    fn field<'a>(json: &'a str, name: &str) -> &'a str {
        let needle = format!("\"{name}\": \"");
        let start = json.find(&needle).expect("field") + needle.len();
        let rest = &json[start..];
        &rest[..rest.find('"').expect("value end")]
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex"))
            .collect()
    }

    /// Arah sebaliknya dari tes Node: fixture yang dihasilkan implementasi Rust
    /// harus bisa DIBUKA oleh implementasi Rust yang sama, sementara tes Node
    /// membuktikan enkapsulasi klien TS menghasilkan byte yang identik dengan
    /// fixture ini saat `ekm`-nya sama. Kalau salah satu sisi menyimpang, salah
    /// satu tes gagal.
    #[test]
    fn fixture_encapsulated_request_decrypts() {
        let json = include_str!("../../../server/tests/fixtures/hpke-xwing-ohttp.json");
        let body = decode_hex(field(json, "encapsulatedRequest"));
        let expected = decode_hex(field(json, "plaintext"));
        assert_eq!(&body[..7], &[KEY_ID, 0x64, 0x7a, 0x00, 0x01, 0x00, 0x02]);
        assert_eq!(body.len(), 7 + 1120 + expected.len() + 16);

        let private_key =
            <XWing as hpke::Kem>::PrivateKey::from_bytes(&decode_hex(field(json, "privateKey")))
                .expect("private key");
        let enc = <XWing as hpke::Kem>::EncappedKey::from_bytes(&body[7..7 + 1120]).expect("enc");
        let mut info = b"message/bhttp request".to_vec();
        info.push(0);
        info.extend_from_slice(&body[..7]);
        let mut context = setup_receiver::<AesGcm256, HkdfSha256, XWing>(
            &OpModeR::Base,
            &private_key,
            &enc,
            &info,
        )
        .expect("receiver context");
        let plaintext = context
            .open(&body[7 + 1120..], &[])
            .expect("open encapsulated request");
        assert_eq!(plaintext, expected);
    }
}
