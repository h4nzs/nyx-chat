// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/30 §30.8 WS-D] Pembungkus WASM untuk crate `spqr` (SparsePostQuantumRatchet,
//! AGPL-3.0, pin `06959b4708f9`).
//!
//! Kenapa **raw wasm tanpa `wasm-bindgen`/`wasm-pack`**:
//!
//!   - toolchain yang dibutuhkan hanya `cargo` + target `wasm32-unknown-unknown`
//!     (tidak ada langkah `wasm-bindgen` tambahan, tidak ada dependensi NPM);
//!   - ABI-nya sengaja primitif (scratch buffer + kode hasil) sehingga modul ini
//!     tidak bisa "bocor" ke JS lewat binding yang tidak kita periksa;
//!   - **entropi disuntik host**, bukan diambil crate: `getrandom` di-arahkan ke
//!     backend `custom` dan diisi dari buffer yang dikirim klien (di produksi =
//!     `crypto.getRandomValues`). Jadi tidak ada `__wbg_getRandomValues` dan tidak
//!     ada glue JS yang perlu dipercaya.
//!
//! Kontrak ABI (semua `i32` = kode hasil, 0 = sukses):
//!
//! | Export | Arti |
//! |---|---|
//! | `spqr_in_ptr()` / `spqr_out_ptr()` / `spqr_out_len()` | alamat scratch buffer |
//! | `spqr_seed_entropy(len)` | isi buffer entropi dari scratch input |
//! | `spqr_empty_state()` | tulis state kosong ke output (untuk perbandingan) |
//! | `spqr_current_version(len)` | 0 = V0, 1 = V1, 100 = masih negosiasi |
//! | `spqr_initial_state(auth_key_len, direction, version, min_version)` | state awal |
//! | `spqr_send(state_len, entropy_len)` | `{state, msg, key}` ber-frame |
//! | `spqr_recv(state_len, msg_len)` | `{state, key}` ber-frame |
//!
//! Framing output `spqr_send`: `u32 state_len | state | u32 msg_len | msg | u8 key_present | u32 key_len | key`.
//! Framing output `spqr_recv`: `u32 state_len | state | u8 key_present | u32 key_len | key`.

use std::cell::RefCell;

use spqr::{ChainParams, Direction, Params, Version};

/// Ukuran scratch buffer (byte). State SPQR ter-serialisasi kecil (KB), pesan
/// ter-frame juga; 256 KiB memberi ruang jauh lebih dari cukup untuk satu operasi.
const SCRATCH: usize = 256 * 1024;

/// Batas entropi yang boleh disuntik host (byte).
const MAX_ENTROPY: usize = 4096;

const OK: i32 = 0;
const ERR_CRATE: i32 = 1;
const ERR_ARGS: i32 = 3;
const ERR_ENTROPY: i32 = 4;

const VERSION_STATUS: i32 = 100;

struct Scratch {
    input: Vec<u8>,
    output: Vec<u8>,
    out_len: usize,
    entropy: Vec<u8>,
    entropy_cursor: usize,
}

thread_local! {
    static SCRATCH_STATE: RefCell<Scratch> = RefCell::new(Scratch {
        input: vec![0u8; SCRATCH],
        output: vec![0u8; SCRATCH],
        out_len: 0,
        entropy: Vec::new(),
        entropy_cursor: 0,
    });
}

/// Backend `getrandom` kustom: mengisi dari buffer yang disuntik host.
fn custom_entropy(dest: &mut [u8]) -> Result<(), getrandom::Error> {
    SCRATCH_STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        let available = state.entropy.len().saturating_sub(state.entropy_cursor);
        if available < dest.len() {
            return Err(getrandom::Error::new_custom(ERR_ENTROPY as u16));
        }
        let start = state.entropy_cursor;
        dest.copy_from_slice(&state.entropy[start..start + dest.len()]);
        state.entropy_cursor += dest.len();
        Ok(())
    })
}

/// Titik masuk backend `getrandom` (cfg `getrandom_backend="custom"`, docs
/// getrandom 0.3 §"custom backend"). Wajib didefinisikan **sekali** di crate
/// akar — tepatnya di sini, supaya tidak ada import JS/wasm-bindgen sama sekali.
///
/// # Safety
/// Dipanggil oleh `getrandom`; `dest`/`len` diberikan runtime dan wajib valid.
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    if dest.is_null() {
        return Err(getrandom::Error::new_custom(ERR_ARGS as u16));
    }
    // Buffer dari getrandom boleh belum terinisialisasi; kita menulis seluruhnya
    // (atau mengembalikan Err tanpa menulis) — jadi tidak ada byte tak terinisialisasi
    // yang terbaca.
    let slice = unsafe { std::slice::from_raw_parts_mut(dest, len) };
    custom_entropy(slice)
}

fn write_output(bytes: &[u8]) -> i32 {
    SCRATCH_STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if bytes.len() > SCRATCH {
            return ERR_ARGS;
        }
        state.output[..bytes.len()].copy_from_slice(bytes);
        state.out_len = bytes.len();
        OK
    })
}

fn read_input(length: usize) -> Option<Vec<u8>> {
    if length > SCRATCH {
        return None;
    }
    SCRATCH_STATE.with(|cell| Some(cell.borrow().input[..length].to_vec()))
}

fn push_u32(out: &mut Vec<u8>, value: usize) {
    out.extend_from_slice(&(value as u32).to_be_bytes());
}

/// Alamat scratch input (host menulis data masukan di sini).
#[no_mangle]
pub extern "C" fn spqr_in_ptr() -> u32 {
    SCRATCH_STATE.with(|cell| cell.borrow().input.as_ptr() as u32)
}

/// Alamat scratch output (host membaca hasil di sini).
#[no_mangle]
pub extern "C" fn spqr_out_ptr() -> u32 {
    SCRATCH_STATE.with(|cell| cell.borrow().output.as_ptr() as u32)
}

/// Panjang hasil terakhir (byte) — 0 berarti operasi terakhir tidak menulis apa pun.
#[no_mangle]
pub extern "C" fn spqr_out_len() -> u32 {
    SCRATCH_STATE.with(|cell| cell.borrow().out_len as u32)
}

/// Isi buffer entropi dari scratch input (dipanggil host sebelum operasi acak).
#[no_mangle]
pub extern "C" fn spqr_seed_entropy(length: u32) -> i32 {
    let length = length as usize;
    if length == 0 || length > MAX_ENTROPY {
        return ERR_ARGS;
    }
    let Some(bytes) = read_input(length) else {
        return ERR_ARGS;
    };
    SCRATCH_STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        state.entropy = bytes;
        state.entropy_cursor = 0;
        OK
    })
}

/// State kosong (referensi untuk perbandingan/uji).
#[no_mangle]
pub extern "C" fn spqr_empty_state() -> i32 {
    let state = spqr::empty_state();
    write_output(&state)
}

/// Versi protokol ratchet dari state: 0 = V0, 1 = V1, 100 = masih negosiasi.
#[no_mangle]
pub extern "C" fn spqr_current_version(state_len: u32) -> i32 {
    let Some(state) = read_input(state_len as usize) else {
        return ERR_ARGS;
    };
    match spqr::current_version(&state) {
        Ok(spqr::CurrentVersion::NegotiationComplete(version)) => {
            let code = match version {
                Version::V0 => 0u32,
                Version::V1 => 1u32,
            };
            write_output(&code.to_be_bytes())
        }
        Ok(spqr::CurrentVersion::StillNegotiating { .. }) => {
            write_output(&(VERSION_STATUS as u32).to_be_bytes())
        }
        Err(_) => ERR_CRATE,
    }
}

fn direction_from_code(code: u32) -> Option<Direction> {
    match code {
        0 => Some(Direction::A2B),
        1 => Some(Direction::B2A),
        _ => None,
    }
}

fn version_from_code(code: u32) -> Option<Version> {
    match code {
        0 => Some(Version::V0),
        1 => Some(Version::V1),
        _ => None,
    }
}

/// State awal: `auth_key` dibaca dari awal scratch input (`auth_key_len` byte).
#[no_mangle]
pub extern "C" fn spqr_initial_state(
    auth_key_len: u32,
    direction: u32,
    version: u32,
    min_version: u32,
) -> i32 {
    let Some(auth_key) = read_input(auth_key_len as usize) else {
        return ERR_ARGS;
    };
    let (Some(direction), Some(version), Some(min_version)) = (
        direction_from_code(direction),
        version_from_code(version),
        version_from_code(min_version),
    ) else {
        return ERR_ARGS;
    };

    let params = Params {
        direction,
        version,
        min_version,
        auth_key: &auth_key,
        chain_params: ChainParams::default(),
    };

    match spqr::initial_state(params) {
        Ok(state) => write_output(&state),
        Err(_) => ERR_CRATE,
    }
}

/// `send`: `state` di awal scratch input (`state_len` byte).
#[no_mangle]
pub extern "C" fn spqr_send(state_len: u32, entropy_len: u32) -> i32 {
    let Some(state) = read_input(state_len as usize) else {
        return ERR_ARGS;
    };
    if entropy_len == 0 || entropy_len as usize > MAX_ENTROPY {
        return ERR_ARGS;
    }
    // Entropi wajib disuntik lebih dulu lewat `spqr_seed_entropy`.
    let has_entropy = SCRATCH_STATE.with(|cell| !cell.borrow().entropy.is_empty());
    if !has_entropy {
        return ERR_ENTROPY;
    }

    let mut rng = OsRngShim;
    match spqr::send(&state, &mut rng) {
        Ok(send) => {
            let mut out = Vec::with_capacity(state.len() + send.msg.len() + 32);
            push_u32(&mut out, send.state.len());
            out.extend_from_slice(&send.state);
            push_u32(&mut out, send.msg.len());
            out.extend_from_slice(&send.msg);
            match &send.key {
                Some(key) => {
                    out.push(1);
                    push_u32(&mut out, key.len());
                    out.extend_from_slice(key);
                }
                None => {
                    out.push(0);
                    push_u32(&mut out, 0);
                }
            }
            write_output(&out)
        }
        Err(_) => ERR_CRATE,
    }
}

/// `recv`: `state` di awal scratch input, lalu `msg` setelahnya.
#[no_mangle]
pub extern "C" fn spqr_recv(state_len: u32, msg_len: u32) -> i32 {
    let total = (state_len as usize).saturating_add(msg_len as usize);
    let Some(bytes) = read_input(total) else {
        return ERR_ARGS;
    };
    // `SerializedState`/`SerializedMessage` = `Vec<u8>` di crate aslinya, jadi
    // potongannya disalin ke Vec (bukan dipinjam dari scratch).
    let state = bytes[..state_len as usize].to_vec();
    let msg = bytes[state_len as usize..].to_vec();

    match spqr::recv(&state, &msg) {
        Ok(recv) => {
            let mut out = Vec::with_capacity(recv.state.len() + 16);
            push_u32(&mut out, recv.state.len());
            out.extend_from_slice(&recv.state);
            match &recv.key {
                Some(key) => {
                    out.push(1);
                    push_u32(&mut out, key.len());
                    out.extend_from_slice(key);
                }
                None => {
                    out.push(0);
                    push_u32(&mut out, 0);
                }
            }
            write_output(&out)
        }
        Err(_) => ERR_CRATE,
    }
}

/// RNG yang menarik seluruh byte-nya dari buffer entropi host (lihat
/// `custom_entropy`) — jadi deterministik & bisa diaudit dari sisi klien.
struct OsRngShim;

impl rand::RngCore for OsRngShim {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        self.fill_bytes(&mut buf);
        u32::from_be_bytes(buf)
    }

    fn next_u64(&mut self) -> u64 {
        let mut buf = [0u8; 8];
        self.fill_bytes(&mut buf);
        u64::from_be_bytes(buf)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        // `getrandom` sudah diarahkan ke backend custom; kegagalan di sini berarti
        // host tidak menyuntik entropi cukup, dan itu kesalahan pemanggil.
        getrandom::fill(dest).expect("entropy exhausted");
    }
}

impl rand::CryptoRng for OsRngShim {}
