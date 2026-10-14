// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/30 §30.5 WS-A / docs/34] Verifier Key Transparency di klien — pembungkus
//! WASM untuk crate `libsignal-keytrans` (pin `e8cc2dddd578`).
//!
//! Ini bagian keamanan yang dulu hilang: memverifikasi **search proof**,
//! **monitor proof**, dan **konsistensi distinguished tree head** dengan kunci
//! publik log, sebelum nilai dari server dipakai. Tanpa ini, server bisa
//! menyajikan bundle kunci palsu yang konsisten dengan dirinya sendiri.
//!
//! Sama seperti pembungkus `spqr` (`packages/spqr-wasm`): modul **raw WASM tanpa
//! `wasm-bindgen`**, **nol import**, ABI primitif (scratch buffer + framing
//! panjang), dan protobuf di-decode/encode di dalam Rust (JS tidak perlu parser
//! protobuf).
//!
//! ## Framing
//!
//! Frame masukan (semua angka big-endian):
//!
//! ```text
//! u8  op
//! u8  mode                 1 = ContactMonitoring, 2 = ThirdPartyManagement(keys), 3 = ThirdPartyAuditing(keys)
//! u32 n_auditor_keys ; n × 32 byte
//! 32B signature_key        (ed25519, operator log)
//! 32B vrf_key              (compressed Edwards point)
//! u64 now_ms               (jam host — WASM tidak boleh memanggil SystemTime::now)
//! u8  force_monitor
//! bytes payload_a .. payload_d   (masing-masing u32 panjang + isi; opsional = panjang 0)
//! ```
//!
//! Frame keluaran:
//!
//! ```text
//! u8  status              0 = ok, 1 = error
//! bytes out_a .. out_d    (masing-masing u32 panjang + isi)
//! u32 len + ascii         pesan error (hanya berarti bila status = 1)
//! ```
//!
//! Semua kegagalan dikembalikan sebagai status/kode — **tidak ada panic**: dengan
//! `panic = "abort"` satu panic akan mematikan instance WASM. Karena itu setiap
//! input divalidasi sebelum masuk ke crate (yang punya `expect` internal).

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use libsignal_keytrans::{
    CondensedTreeSearchResponse, DeploymentMode, FullSearchResponse, FullTreeHead, KeyTransparency,
    LastTreeHead, MonitorContext, MonitorRequest, MonitorResponse, MonitoringData, PublicConfig,
    SearchContext, SlimSearchRequest, StoredMonitoringData, StoredTreeHead, VerifyingKey,
    VrfPublicKey,
};
use prost::Message;

/// Ukuran scratch buffer (byte). Proof terbesar (monitor dengan banyak kunci)
/// masih jauh di bawah ini.
const SCRATCH: usize = 512 * 1024;

const OK: i32 = 0;
const ERR_ARGS: i32 = 3;

const OP_VERIFY_SEARCH: u8 = 1;
const OP_VERIFY_MONITOR: u8 = 2;
const OP_VERIFY_DISTINGUISHED: u8 = 3;
const OP_MONITOR_NEXT: u8 = 4;
const OP_CONDENSE_UPDATE: u8 = 5;
const OP_MONITOR_BUILD: u8 = 6;

/// `version` pada `SlimSearchRequest` = "tanpa batas versi".
const NO_VERSION: u32 = u32::MAX;

// ---------------------------------------------------------------------------
// Scratch buffer (host menulis input, membaca output)
// ---------------------------------------------------------------------------

struct Scratch {
    input: Vec<u8>,
    output: Vec<u8>,
}

thread_local! {
    static SCRATCH_STATE: std::cell::RefCell<Scratch> = std::cell::RefCell::new(Scratch {
        input: vec![0u8; SCRATCH],
        output: vec![0u8; SCRATCH],
    });
}

/// Alamat scratch input (host menulis frame masukan di sini).
#[no_mangle]
pub extern "C" fn kt_in_ptr() -> u32 {
    SCRATCH_STATE.with(|cell| cell.borrow().input.as_ptr() as u32)
}

/// Alamat scratch output (host membaca frame hasil di sini).
#[no_mangle]
pub extern "C" fn kt_out_ptr() -> u32 {
    SCRATCH_STATE.with(|cell| cell.borrow().output.as_ptr() as u32)
}

fn write_output(frame: &[u8]) -> i32 {
    SCRATCH_STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if frame.len() > SCRATCH {
            return ERR_ARGS;
        }
        state.output[..frame.len()].copy_from_slice(frame);
        OK
    })
}

fn read_input(length: usize) -> Option<Vec<u8>> {
    if length > SCRATCH {
        return None;
    }
    SCRATCH_STATE.with(|cell| Some(cell.borrow().input[..length].to_vec()))
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(length).ok_or("frame: panjang meluap")?;
        if end > self.buf.len() {
            return Err("frame: data masukan terpotong".to_string());
        }
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn u64(&mut self) -> Result<u64, String> {
        let bytes = self.take(8)?;
        let mut raw = [0u8; 8];
        raw.copy_from_slice(bytes);
        Ok(u64::from_be_bytes(raw))
    }

    /// Field `u32 panjang + isi`.
    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let length = self.u32()? as usize;
        self.take(length)
    }

    fn array32(&mut self) -> Result<[u8; 32], String> {
        let bytes = self.take(32)?;
        let mut out = [0u8; 32];
        out.copy_from_slice(bytes);
        Ok(out)
    }
}

#[derive(Default)]
struct Writer {
    out: Vec<u8>,
}

impl Writer {
    fn u32(&mut self, value: u32) {
        self.out.extend_from_slice(&value.to_be_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.out.extend_from_slice(&value.to_be_bytes());
    }

    fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len() as u32);
        self.out.extend_from_slice(value);
    }
}

fn ok_frame(writer: &Writer) -> Vec<u8> {
    let mut out = Vec::with_capacity(writer.out.len() + 5);
    out.push(0);
    out.extend_from_slice(&writer.out);
    out.extend_from_slice(&0u32.to_be_bytes()); // pesan error kosong
    out
}

fn err_frame(message: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(1);
    for _ in 0..4 {
        out.extend_from_slice(&0u32.to_be_bytes());
    }
    let bytes = message.as_bytes();
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
    out
}

// ---------------------------------------------------------------------------
// Konversi tipe (dengan validasi — tanpa panic)
// ---------------------------------------------------------------------------

fn decoding_keys_from_stored(stored: &StoredMonitoringData) -> Result<MonitoringData, String> {
    if stored.index.len() != 32 {
        return Err("monitoring data: index bukan 32 byte".to_string());
    }
    if stored.ptrs.is_empty() {
        return Err("monitoring data: ptrs kosong".to_string());
    }
    // `From<StoredMonitoringData>` memakai `expect` pada panjang index; kita
    // sudah memvalidasinya, jadi jalur ini tidak bisa panic.
    Ok(MonitoringData::from(stored.clone()))
}

fn stored_from_monitoring(
    data: &MonitoringData,
    search_key: Vec<u8>,
) -> Result<StoredMonitoringData, String> {
    if data.index.len() != 32 {
        return Err("monitoring data: index bukan 32 byte".to_string());
    }
    Ok(StoredMonitoringData {
        index: data.index.to_vec(),
        pos: data.pos,
        ptrs: data.ptrs.clone(),
        owned: data.owned,
        search_key,
        max_observed_version: data.max_observed_version,
    })
}

fn last_tree_head_from_stored(bytes: &[u8]) -> Result<Option<LastTreeHead>, String> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let stored = StoredTreeHead::decode(bytes).map_err(|e| format!("tree head tidak bisa dibaca: {e}"))?;
    stored
        .into_last_tree_head()
        .map(Some)
        .ok_or_else(|| "tree head tidak lengkap (tree_head/root hilang)".to_string())
}

/// Bahan konfigurasi apa adanya dari frame; divalidasi hanya saat dipakai (op 4/5
/// tidak butuh kunci sama sekali).
struct ConfigBytes {
    mode: u8,
    auditor_keys: Vec<[u8; 32]>,
    signature_key: [u8; 32],
    vrf_key: [u8; 32],
}

impl ConfigBytes {
    fn to_public_config(&self) -> Result<PublicConfig, String> {
        let mut auditor_keys = Vec::with_capacity(self.auditor_keys.len());
        for raw in &self.auditor_keys {
            let key = VerifyingKey::from_bytes(raw).map_err(|e| format!("kunci auditor tidak sah: {e}"))?;
            auditor_keys.push(key);
        }
        let signature_key = VerifyingKey::from_bytes(&self.signature_key)
            .map_err(|e| format!("kunci tanda tangan operator tidak sah: {e}"))?;
        let vrf_key = VrfPublicKey::try_from(self.vrf_key)
            .map_err(|_| "kunci VRF tidak sah (titik kurva ditolak)".to_string())?;
        let mode = match self.mode {
            1 => DeploymentMode::ContactMonitoring,
            2 => DeploymentMode::ThirdPartyManagement(auditor_keys.into()),
            3 => DeploymentMode::ThirdPartyAuditing(auditor_keys.into()),
            other => return Err(format!("mode deployment tidak dikenal: {other}")),
        };
        Ok(PublicConfig {
            mode,
            signature_key,
            vrf_key,
        })
    }
}

/// Parse frame masukan yang bersifat umum (op + config + jam).
struct Request {
    op: u8,
    config_bytes: ConfigBytes,
    now: SystemTime,
    force_monitor: bool,
    payload: [Vec<u8>; 4],
}

impl Request {
    fn parse(frame: &[u8]) -> Result<Self, String> {
        let mut reader = Reader::new(frame);
        let op = reader.u8()?;
        let mode = reader.u8()?;
        let key_count = reader.u32()? as usize;
        if key_count > 64 {
            return Err("konfigurasi: terlalu banyak kunci auditor".to_string());
        }
        let mut auditor_keys = Vec::with_capacity(key_count);
        for _ in 0..key_count {
            auditor_keys.push(reader.array32()?);
        }
        let signature_key = reader.array32()?;
        let vrf_key = reader.array32()?;
        let now_ms = reader.u64()?;
        let force_monitor = reader.u8()? != 0;

        let mut payload: [Vec<u8>; 4] = Default::default();
        for slot in payload.iter_mut() {
            *slot = reader.bytes()?.to_vec();
        }

        let now = UNIX_EPOCH + Duration::from_millis(now_ms);
        Ok(Self {
            op,
            config_bytes: ConfigBytes {
                mode,
                auditor_keys,
                signature_key,
                vrf_key,
            },
            now,
            force_monitor,
            payload,
        })
    }

    fn public_config(&self) -> Result<PublicConfig, String> {
        self.config_bytes.to_public_config()
    }
}

// ---------------------------------------------------------------------------
// Protobuf byte-tingkat (untuk `kt_condense_update`)
// ---------------------------------------------------------------------------

/// Baca satu varint dari `bytes[offset..]`.
fn read_varint(bytes: &[u8], offset: usize) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    let mut shift = 0;
    let mut index = offset;
    while index < bytes.len() {
        let byte = bytes[index];
        value |= ((byte & 0x7f) as u64) << shift;
        index += 1;
        if byte & 0x80 == 0 {
            return Some((value, index));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// Field length-delimited (`2 << 3 | 2`, `3 << 3 | 2`, dst.).
fn encode_bytes_field(out: &mut Vec<u8>, field: u64, payload: &[u8]) {
    write_varint(out, (field << 3) | 2);
    write_varint(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

/// Field varint (`field << 3 | 0`) — mis. `uint64 entry_position`.
fn encode_varint_field(out: &mut Vec<u8>, field: u64, value: u64) {
    write_varint(out, field << 3);
    write_varint(out, value);
}

/// Pisahkan pesan protobuf menjadi (nomor field, payload) untuk field
/// length-delimited. Field dengan wire-type lain dilewati dengan benar.
fn split_len_fields(bytes: &[u8]) -> Result<HashMap<u64, Vec<u8>>, String> {
    let mut out: HashMap<u64, Vec<u8>> = HashMap::new();
    let mut index = 0usize;
    while index < bytes.len() {
        let Some((key, next)) = read_varint(bytes, index) else {
            return Err("protobuf: varint kunci field rusak".to_string());
        };
        index = next;
        let field = key >> 3;
        let wire = key & 0x07;
        match wire {
            0 => {
                let Some((_, next)) = read_varint(bytes, index) else {
                    return Err("protobuf: varint nilai rusak".to_string());
                };
                index = next;
            }
            2 => {
                let Some((length, next)) = read_varint(bytes, index) else {
                    return Err("protobuf: panjang field rusak".to_string());
                };
                index = next;
                let end = index.checked_add(length as usize).ok_or("protobuf: panjang meluap")?;
                if end > bytes.len() {
                    return Err("protobuf: field terpotong".to_string());
                }
                out.insert(field, bytes[index..end].to_vec());
                index = end;
            }
            5 => index = index.checked_add(4).ok_or("protobuf: field 32-bit meluap")?,
            1 => index = index.checked_add(8).ok_or("protobuf: field 64-bit meluap")?,
            other => return Err(format!("protobuf: wire-type tidak didukung: {other}")),
        }
        if index > bytes.len() {
            return Err("protobuf: field melewati akhir pesan".to_string());
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Operasi
// ---------------------------------------------------------------------------

/// `transparency.UpdateResponse` (dari penulis log NYX / test service) →
/// `FullTreeHead` + `CondensedTreeSearchResponse` yang bisa diverifikasi
/// `verify_search`. Nilai yang ditulis klien diberikan terpisah (field `b`),
/// karena `UpdateResponse` tidak memuatnya.
///
/// Field di-`tag` ulang di tingkat byte: protobuf-nya kompatibel wire
/// (`UpdateResponse` 2/3/4 = `vrf_proof`/`search`/`opening`), jadi tidak perlu
/// menambah tipe internal crate yang tidak diekspor.
fn condense_update(req: &Request) -> Result<Writer, String> {
    let update = split_len_fields(&req.payload[0])?;
    let tree_head = update
        .get(&1)
        .ok_or_else(|| "update response: tree_head hilang".to_string())?;
    let vrf_proof = update
        .get(&2)
        .ok_or_else(|| "update response: vrf_proof hilang".to_string())?;
    let search = update
        .get(&3)
        .ok_or_else(|| "update response: search proof hilang".to_string())?;
    let opening = update
        .get(&4)
        .ok_or_else(|| "update response: opening hilang".to_string())?;
    let value = &req.payload[1];
    if value.is_empty() {
        return Err("update response: nilai log kosong".to_string());
    }

    let mut condensed = Vec::new();
    encode_bytes_field(&mut condensed, 1, vrf_proof);
    encode_bytes_field(&mut condensed, 2, search);
    encode_bytes_field(&mut condensed, 3, opening);
    // `UpdateValue { bytes value = 1 }` di-inline sebagai sub-pesan field 4.
    let mut update_value = Vec::new();
    encode_bytes_field(&mut update_value, 1, value);
    encode_bytes_field(&mut condensed, 4, &update_value);

    let mut writer = Writer::default();
    writer.bytes(tree_head);
    writer.bytes(&condensed);
    Ok(writer)
}

fn verify_search(req: &Request) -> Result<Writer, String> {
    let search_key = req.payload[0].clone();
    if search_key.is_empty() {
        return Err("search key kosong".to_string());
    }
    let condensed = CondensedTreeSearchResponse::decode(req.payload[1].as_slice())
        .map_err(|e| format!("respons search tidak bisa dibaca: {e}"))?;
    let full_tree_head = FullTreeHead::decode(req.payload[2].as_slice())
        .map_err(|e| format!("tree head tidak bisa dibaca: {e}"))?;

    let mut context_reader = Reader::new(req.payload[3].as_slice());
    let version_code = context_reader.u32()?;
    let last_tree_head_bytes = context_reader.bytes()?;
    let last_distinguished_bytes = context_reader.bytes()?;
    let monitoring_bytes = context_reader.bytes()?;

    let last_tree_head = last_tree_head_from_stored(last_tree_head_bytes)?;
    let last_distinguished = last_tree_head_from_stored(last_distinguished_bytes)?;
    let monitoring = if monitoring_bytes.is_empty() {
        None
    } else {
        let stored = StoredMonitoringData::decode(monitoring_bytes)
            .map_err(|e| format!("monitoring data tidak bisa dibaca: {e}"))?;
        Some(decoding_keys_from_stored(&stored)?)
    };

    let kt = KeyTransparency {
        config: req.public_config()?,
    };
    let request = SlimSearchRequest {
        search_key: search_key.clone(),
        version: if version_code == NO_VERSION {
            None
        } else {
            Some(version_code)
        },
    };
    let context = SearchContext {
        last_tree_head: last_tree_head.as_ref(),
        last_distinguished_tree_head: last_distinguished.as_ref(),
        data: monitoring,
    };

    let result = kt
        .verify_search(
            request,
            FullSearchResponse::new(condensed, &full_tree_head),
            context,
            req.force_monitor,
            req.now,
        )
        .map_err(|e| format!("verifikasi search gagal: {e}"))?;

    let state = &result.state_update;
    let stored_head = StoredTreeHead {
        tree_head: Some(state.tree_head.clone()),
        root: state.tree_root.to_vec(),
        stored_at_ms: now_ms(req),
    };
    let mut stored_monitoring = Vec::new();
    if let Some(data) = &state.monitoring_data {
        let stored = stored_from_monitoring(data, search_key)?;
        stored_monitoring = stored.encode_to_vec();
    }

    let mut writer = Writer::default();
    writer.bytes(&result.value);
    writer.bytes(&stored_head.encode_to_vec());
    writer.bytes(&stored_monitoring);
    Ok(writer)
}

/// Jam host (ms sejak epoch). `now` sudah dinormalkan dari frame masukan, jadi
/// konversi balik tidak pernah gagal — `unwrap_or(0)` hanya kejaga-jagaan.
fn now_ms(req: &Request) -> u64 {
    req.now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn verify_monitor(req: &Request) -> Result<Writer, String> {
    let request = MonitorRequest::decode(req.payload[0].as_slice())
        .map_err(|e| format!("monitor request tidak bisa dibaca: {e}"))?;
    let response = MonitorResponse::decode(req.payload[1].as_slice())
        .map_err(|e| format!("monitor response tidak bisa dibaca: {e}"))?;

    let mut context_reader = Reader::new(req.payload[2].as_slice());
    let last_tree_head_bytes = context_reader.bytes()?;
    let last_distinguished_bytes = context_reader.bytes()?;
    let entry_count = context_reader.u32()? as usize;
    if entry_count > 4096 {
        return Err("konteks monitor: terlalu banyak kunci".to_string());
    }
    let mut data: HashMap<Vec<u8>, MonitoringData> = HashMap::with_capacity(entry_count);
    for _ in 0..entry_count {
        let key = context_reader.bytes()?.to_vec();
        let stored_bytes = context_reader.bytes()?;
        let stored = StoredMonitoringData::decode(stored_bytes)
            .map_err(|e| format!("monitoring data tidak bisa dibaca: {e}"))?;
        data.insert(key, decoding_keys_from_stored(&stored)?);
    }

    let last_tree_head = last_tree_head_from_stored(last_tree_head_bytes)?;
    let last_distinguished = last_tree_head_from_stored(last_distinguished_bytes)?
        .ok_or_else(|| "konteks monitor: distinguished tree head wajib ada".to_string())?;

    let kt = KeyTransparency {
        config: req.public_config()?,
    };
    let context = MonitorContext {
        last_tree_head: last_tree_head.as_ref(),
        last_distinguished_tree_head: &last_distinguished,
        data,
    };

    let update = kt
        .verify_monitor(&request, &response, context, req.now)
        .map_err(|e| format!("verifikasi monitor gagal: {e}"))?;

    let stored_head = StoredTreeHead {
        tree_head: Some(update.tree_head.clone()),
        root: update.tree_root.to_vec(),
        stored_at_ms: now_ms(req),
    };

    let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::with_capacity(update.monitoring_data.len());
    for (key, value) in &update.monitoring_data {
        let stored = stored_from_monitoring(value, key.clone())?;
        entries.push((key.clone(), stored.encode_to_vec()));
    }

    let mut writer = Writer::default();
    writer.bytes(&stored_head.encode_to_vec());
    writer.u32(entries.len() as u32);
    for (key, value) in entries {
        writer.bytes(&key);
        writer.bytes(&value);
    }
    Ok(writer)
}

fn verify_distinguished(req: &Request) -> Result<Writer, String> {
    let full_tree_head = FullTreeHead::decode(req.payload[0].as_slice())
        .map_err(|e| format!("tree head tidak bisa dibaca: {e}"))?;
    let last_tree_head = last_tree_head_from_stored(&req.payload[1])?;
    let last_distinguished = last_tree_head_from_stored(&req.payload[2])?
        .ok_or_else(|| "distinguished: tree head rujukan wajib ada".to_string())?;

    let kt = KeyTransparency {
        config: req.public_config()?,
    };
    kt.verify_distinguished(&full_tree_head, last_tree_head.as_ref(), &last_distinguished)
        .map_err(|e| format!("verifikasi distinguished gagal: {e}"))?;
    Ok(Writer::default())
}

/// Helper untuk membangun `MonitorRequest`: dari monitoring data yang tersimpan,
/// klien butuh `next_monitor`, daftar entry, versi terbesar, dan posisi terakhir.
fn monitor_next(req: &Request) -> Result<Writer, String> {
    if req.payload[0].is_empty() {
        return Err("monitoring data kosong".to_string());
    }
    let stored = StoredMonitoringData::decode(req.payload[0].as_slice())
        .map_err(|e| format!("monitoring data tidak bisa dibaca: {e}"))?;
    let data = decoding_keys_from_stored(&stored)?;
    let entries = data.entries();

    let mut writer = Writer::default();
    writer.u64(data.next_monitor());
    writer.u64(data.latest_log_position());
    writer.u32(data.greatest_version());
    writer.u32(entries.len() as u32);
    for entry in entries {
        writer.u64(entry);
    }
    Ok(writer)
}

/// Ukuran pohon dari `StoredTreeHead` (byte kosong = tidak ada tree head).
fn tree_size_from_stored(bytes: &[u8]) -> Result<Option<u64>, String> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let stored = StoredTreeHead::decode(bytes).map_err(|e| format!("tree head tidak bisa dibaca: {e}"))?;
    Ok(stored.tree_head.map(|head| head.tree_size))
}

/// Bangun `transparency.MonitorRequest` dari monitoring data + tree head yang
/// sudah dimiliki klien (langkah yang `docs/34` §34.6 poin 2 catat belum ada).
///
/// Klien tidak perlu parser protobuf: permintaan dirakit di sini dari byte yang
/// sudah ia simpan (`StoredMonitoringData`/`StoredTreeHead` keluaran op 1/2).
///
/// payload[0] = `StoredTreeHead` terakhir (opsional)
/// payload[1] = `StoredTreeHead` distinguished (wajib — anchor monitoring)
/// payload[2] = frame: `u32 n`, lalu `n ×` (`u32 len` + `StoredMonitoringData`)
///
/// Keluaran: `MonitorRequest` (protobuf) siap dikirim ke `/api/keys/kt/monitor`.
fn monitor_build(req: &Request) -> Result<Writer, String> {
    let last = tree_size_from_stored(&req.payload[0])?;
    let distinguished = tree_size_from_stored(&req.payload[1])?
        .ok_or_else(|| "monitor build: distinguished tree head wajib ada".to_string())?;

    let mut reader = Reader::new(req.payload[2].as_slice());
    let count = reader.u32()? as usize;
    if count == 0 {
        return Err("monitor build: tidak ada kunci untuk dimonitor".to_string());
    }
    if count > 64 {
        return Err("monitor build: terlalu banyak kunci (maks 64)".to_string());
    }

    // `MonitorRequest.keys` = repeated MonitorKey (field 1, length-delimited).
    let mut keys_blob = Vec::new();
    for _ in 0..count {
        let stored_bytes = reader.bytes()?;
        let stored = StoredMonitoringData::decode(stored_bytes)
            .map_err(|e| format!("monitoring data tidak bisa dibaca: {e}"))?;
        let data = decoding_keys_from_stored(&stored)?;
        let search_key = if data.search_key.is_empty() {
            stored.search_key.clone()
        } else {
            data.search_key.clone()
        };
        if search_key.is_empty() {
            return Err("monitor build: search key kosong".to_string());
        }
        // MonitorKey { bytes search_key = 1; uint64 entry_position = 2; bytes commitment_index = 3 }
        let mut key = Vec::new();
        encode_bytes_field(&mut key, 1, &search_key);
        encode_varint_field(&mut key, 2, data.latest_log_position());
        encode_bytes_field(&mut key, 3, &data.index);
        encode_bytes_field(&mut keys_blob, 1, &key);
    }

    // Consistency { optional uint64 last = 1; optional uint64 distinguished = 2 }
    let mut consistency = Vec::new();
    if let Some(last) = last {
        encode_varint_field(&mut consistency, 1, last);
    }
    encode_varint_field(&mut consistency, 2, distinguished);

    let mut message = keys_blob;
    encode_bytes_field(&mut message, 2, &consistency);

    let mut writer = Writer::default();
    writer.bytes(&message);
    Ok(writer)
}

/// Titik masuk tunggal: host menulis frame ke `kt_in_ptr()`, memanggil ini
/// dengan panjang frame, lalu membaca hasil dari `kt_out_ptr()`.
#[no_mangle]
pub extern "C" fn kt_run(input_len: u32) -> i32 {
    let Some(frame) = read_input(input_len as usize) else {
        return write_output(&err_frame("frame masukan melebihi scratch"));
    };

    let result = match Request::parse(&frame) {
        Ok(req) => match req.op {
            OP_VERIFY_SEARCH => verify_search(&req),
            OP_VERIFY_MONITOR => verify_monitor(&req),
            OP_VERIFY_DISTINGUISHED => verify_distinguished(&req),
            OP_MONITOR_NEXT => monitor_next(&req),
            OP_CONDENSE_UPDATE => condense_update(&req),
            OP_MONITOR_BUILD => monitor_build(&req),
            other => Err(format!("op tidak dikenal: {other}")),
        },
        Err(message) => Err(message),
    };

    match result {
        Ok(writer) => write_output(&ok_frame(&writer)),
        Err(message) => write_output(&err_frame(&message)),
    }
}
