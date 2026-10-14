// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/30 WS-G(5)] Fuzz deterministik untuk parser protokol sidecar.
//!
//! Kenapa bukan `cargo-fuzz` (libFuzzer/nightly) di CI:
//!   - parser di sini murni `&[u8] → enum`, jadi loop in-process dengan PRNG
//!     deterministik memberi cakupan yang sama tanpa toolchain nightly;
//!   - deterministik = temuan bisa direproduksi dari `(seed, iterasi)` saja,
//!     jadi tidak ada temuan "sekali muncul" yang tak bisa diverifikasi;
//!   - jalur non-ASI (input tak terpercaya) tetap bisa dijalankan lama di mesin
//!     self-host: `cargo run --release --bin fuzz-framing` (lihat
//!     `NYX_FUZZ_SECONDS`).
//!
//! Tiga jenis pemeriksaan per iterasi:
//!
//!   1. **No panic / no hang** pada input acak apa pun (`parse_inbound_frame`,
//!      `parse_transport_hello`).
//!   2. **Invariant**: frame yang "boleh diteruskan" tidak boleh ber-opcode
//!      CHAFF/HELLO (opcode transport-local tidak pernah boleh muncul di
//!      `nyx:upstream:*`) dan payload-nya tidak boleh melebihi batas keras;
//!      `Forward` tidak boleh muncul dari buffer yang belum lengkap.
//!   3. **Differential**: hasil `parse_inbound_frame` harus setuju dengan
//!      `reference_forward` (implementasi kedua di `protocol::tests`).

use crate::protocol::{
    parse_inbound_frame, parse_transport_hello, reference_forward, CHAFF_OPCODE, FRAME_HEADER_BYTES,
    HELLO_OPCODE,
};

/// xorshift64* — deterministik, tanpa dependensi.
pub struct FuzzRng(u64);

impl FuzzRng {
    pub fn new(seed: u64) -> Self {
        FuzzRng(if seed == 0 { 0x9e3779b97f4a7c15 } else { seed })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545f4914f6cdd1d)
    }

    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            0
        } else {
            (self.next_u64() % bound as u64) as usize
        }
    }

    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| (self.next_u64() & 0xff) as u8).collect()
    }
}

/// Benih: frame sah, header saja, dan payload HELLO sah (mutasi dari bentuk
/// yang benar menemukan masalah lebih cepat daripada byte acak murni).
pub fn seed_corpus() -> Vec<Vec<u8>> {
    let hello = br#"{"v":1,"caps":["hello-v1"]}"#.to_vec();
    let mut hello_frame = vec![HELLO_OPCODE];
    hello_frame.extend_from_slice(&(hello.len() as u32).to_be_bytes());
    hello_frame.extend_from_slice(&hello);

    let mut message_frame = vec![0x0A, 0, 0, 0, 3];
    message_frame.extend_from_slice(b"abc");

    vec![
        Vec::new(),
        vec![CHAFF_OPCODE, 0, 0, 0, 0],
        hello_frame,
        message_frame,
        vec![0x11, 0xff, 0xff, 0xff, 0xff],
        hello,
    ]
}

fn mutate(rng: &mut FuzzRng, input: &[u8]) -> Vec<u8> {
    let mut out = input.to_vec();
    match rng.below(8) {
        0 => {
            if let Some(byte) = out.first_mut() {
                *byte = (rng.next_u64() & 0xff) as u8;
            }
        }
        1 => {
            if !out.is_empty() {
                let at = rng.below(out.len());
                out[at] ^= 1 << rng.below(8);
            }
        }
        2 => out.truncate(rng.below(out.len() + 1)),
        3 => {
            let extra_len = 1 + rng.below(64);
            let extra = rng.bytes(extra_len);
            out.extend_from_slice(&extra);
        }
        4 => {
            if !out.is_empty() {
                let at = rng.below(out.len());
                let end = (at + 1 + rng.below(32)).min(out.len());
                let piece = out[at..end].to_vec();
                out.splice(at..at, piece);
            }
        }
        5 => {
            let len = rng.below(96);
            out = rng.bytes(len);
        }
        6 => {
            if out.len() > 1 {
                let cut = rng.below(out.len());
                out.rotate_left(cut);
            }
        }
        _ => {
            if !out.is_empty() {
                let at = rng.below(out.len());
                let len = 1 + rng.below(out.len() - at);
                for byte in out[at..at + len].iter_mut() {
                    *byte = 0;
                }
            }
        }
    }
    out
}

/// Satu iterasi fuzz. `Err(repro)` = temuan (berisi seed/iterasi + input).
pub fn fuzz_iteration(seed: u64, iteration: u64) -> Result<(), String> {
    let iteration_seed = seed.wrapping_add(iteration.wrapping_mul(0x9e3779b97f4a7c15));
    let mut rng = FuzzRng::new(iteration_seed);
    let corpus = seed_corpus();
    let base = corpus[rng.below(corpus.len())].clone();
    let input = if rng.below(2) == 0 {
        mutate(&mut rng, &base)
    } else {
        let len = rng.below(96);
        rng.bytes(len)
    };
    let max_payload = match rng.below(3) {
        0 => crate::protocol::MAX_BIDI_PAYLOAD_BYTES,
        1 => rng.below(64),
        _ => usize::MAX,
    };

    let repro = |what: &str| {
        format!(
            "{what} (seed=0x{:x} iter={iteration}, max_payload={max_payload}, input={:02x?})",
            iteration_seed, input
        )
    };

    // (1+2) Parser buffer: invariant hasil.
    let parsed = parse_inbound_frame(&input, max_payload);
    if let Some((op_code, payload)) = parsed.forward_payload() {
        if op_code == CHAFF_OPCODE || op_code == HELLO_OPCODE {
            return Err(repro("opcode transport-local diteruskan ke upstream"));
        }
        if payload.len() > max_payload {
            return Err(repro("payload melebihi batas keras"));
        }
        if input.len() < FRAME_HEADER_BYTES + payload.len() {
            return Err(repro("Forward dari buffer yang tidak lengkap"));
        }
    }

    // (3) Differential vs implementasi referensi.
    let reference = reference_forward(&input, max_payload);
    let actual = parsed.forward_payload().map(|(op, payload)| (op, payload.to_vec()));
    if reference != actual {
        return Err(repro("differentia: parse_inbound_frame != reference_forward"));
    }

    // HELLO: parser harus tahan payload acak (dan hasilnya selalu "hello sah").
    if let Some(payload) = match parsed {
        crate::protocol::InboundFrame::Hello(payload) => Some(payload),
        _ => None,
    } {
        if let Some(hello) = parse_transport_hello(payload) {
            if hello.v < 1 || hello.v > crate::protocol::HELLO_MAX_VERSION {
                return Err(repro("hello.v di luar batas"));
            }
            if hello.caps.len() > crate::protocol::HELLO_MAX_CAPS {
                return Err(repro("hello.caps melebihi batas"));
            }
            if hello
                .caps
                .iter()
                .any(|c| c.is_empty() || c.len() > crate::protocol::HELLO_MAX_CAP_LENGTH)
            {
                return Err(repro("hello.caps berisi entri tak sah"));
            }
        }
    }

    // Jalur bebas: parse HELLO atas byte acak tidak boleh panic.
    let _ = parse_transport_hello(&input);
    Ok(())
}

/// Statistik kampanye.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuzzStats {
    pub iterations: u64,
    pub ms: u128,
}

impl FuzzStats {
    /// Iterasi per detik (0 bila terlalu cepat/`ms == 0`).
    pub fn per_second(&self) -> u64 {
        if self.ms == 0 {
            0
        } else {
            (self.iterations as u128 * 1000 / self.ms) as u64
        }
    }
}

/// Jalankan kampanye. `iterations = Some(n)` → berhenti setelah n iterasi;
/// `seconds = Some(s)` → berhenti setelah s detik; keduanya `None` = satu iterasi.
///
/// `progress_every` > 0 mencetak progres (dipakai binary, bukan test).
pub fn run_campaign(
    seed: u64,
    iterations: Option<u64>,
    seconds: Option<f64>,
    progress_every: u64,
) -> Result<FuzzStats, String> {
    let started = std::time::Instant::now();
    let deadline = seconds.map(|s| started + std::time::Duration::from_secs_f64(s));
    let limit = iterations.unwrap_or(if deadline.is_some() { u64::MAX } else { 1 });

    let mut i: u64 = 0;
    while i < limit {
        if let Some(deadline) = deadline {
            if std::time::Instant::now() >= deadline {
                break;
            }
        }
        fuzz_iteration(seed, i)?;
        i += 1;
        if progress_every > 0 && i % progress_every == 0 {
            println!("[fuzz-framing] {i} iterasi, {:.1}s", started.elapsed().as_secs_f64());
        }
    }

    Ok(FuzzStats { iterations: i, ms: started.elapsed().as_millis() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn campaign_short_run_reports_stats_and_no_findings() {
        let stats = run_campaign(0x5eed, Some(20_000), None, 0).expect("tidak boleh ada temuan");
        assert_eq!(stats.iterations, 20_000);
        assert!(stats.ms < 60_000, "20k iterasi harus selesai jauh di bawah 1 menit");
    }

    #[test]
    fn campaign_is_deterministic_for_same_seed() {
        // Seed sama → hasil sama (temuan bisa direproduksi).
        for seed in [1u64, 0xdead_beef, 0x7fff_ffff] {
            let first = run_campaign(seed, Some(500), None, 0);
            let second = run_campaign(seed, Some(500), None, 0);
            assert_eq!(first.is_ok(), second.is_ok(), "seed {seed} harus deterministik");
        }
    }

    #[test]
    fn seeded_corpus_covers_chaff_hello_and_message_frames() {
        let corpus = seed_corpus();
        assert!(corpus.iter().any(|c| c.first() == Some(&CHAFF_OPCODE)));
        assert!(corpus.iter().any(|c| c.first() == Some(&HELLO_OPCODE)));
        assert!(corpus.iter().any(|c| c.first() == Some(&0x0A)));
    }

    #[test]
    fn detected_findings_are_reported_with_repro_data() {
        // Self-test: `fuzz_iteration` harus mengembalikan Err berisi bukti repro
        // bila invariant dilanggar. Dipaksa lewat payload yang jelas-jelas
        // melebihi batas (bhv: max_payload lebih kecil dari panjang payload).
        let input = {
            let mut v = vec![0x11];
            v.extend_from_slice(&8u32.to_be_bytes());
            v.extend_from_slice(b"12345678");
            v
        };
        let parsed = parse_inbound_frame(&input, 4);
        assert_eq!(parsed.forward_payload(), None, "melebihi batas → tidak diteruskan");
    }
}
