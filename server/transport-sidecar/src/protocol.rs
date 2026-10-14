// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

// ============================================================================
// [docs/30 WS-G(5)] Protokol transport murni (tanpa I/O) — bisa diuji & di-fuzz
// ============================================================================
//
// Sebelum ini, keputusan "frame ini apa dan boleh diteruskan atau tidak" ditulis
// empat kali inline di handler WebTransport (bidi, uni, datagram, + balasan
// HELLO). Akibatnya keputusan penting (CHAFF dibuang, opcode transport-local
// tidak pernah bocor ke `nyx:upstream:*`, batas 32 KB) tidak bisa diuji tanpa
// soket WebTransport nyata.
//
// Modul ini memindahkannya ke fungsi murni:
//   - `classify_inbound`  : keputusan dari header saja (dipakai jalur bidi yang
//                           membaca payload secara streaming),
//   - `parse_inbound_frame`: keputusan 1:1 untuk buffer utuh (uni & datagram),
//   - HELLO: parse + negosiasi kapabilitas + bentuk balasan.
//
// Kontrak numerik harus sinkron dengan `packages/shared/src/transport.ts`
// (HELLO = 0x0B, versi protokol 1, CHAFF = 0x00, frame `[opcode][len:u32 BE][payload]`).

use serde::{Deserialize, Serialize};

/// Opcode HELLO (negosiasi kapabilitas) — sinkron dengan klien TS.
pub const HELLO_OPCODE: u8 = 0x0B;
/// Opcode CHAFF (traffic cover) — payload dibuang, TIDAK pernah diteruskan.
pub const CHAFF_OPCODE: u8 = 0x00;
/// Opcode HANDSHAKE (dibalas ACK langsung oleh jalur bidi).
pub const HANDSHAKE_OPCODE: u8 = 0x0A;
/// Opcode ACK.
pub const ACK_OPCODE: u8 = 0x06;
/// Versi protokol transport yang dipahami sidecar ini.
pub const TRANSPORT_PROTOCOL_VERSION: u32 = 1;
/// Kapabilitas yang diiklankan sidecar.
///
/// `spqr-ratchet` = saklar tingkat deployment untuk jalur ratchet v2 (braid
/// SPQR, `docs/33`): relay hanya meneruskan payload opaque, jadi yang
/// dinyatakan adalah "frame jalur v2 boleh lewat", bukan kemampuan peer mana
/// pun (bukti kemampuan peer datang in-band lewat `ackV` di payload ter-seal).
/// Menghapusnya dari daftar = kill switch deployment (semua klien kembali ke v1).
pub const SERVER_CAPABILITIES: [&str; 2] = ["hello-v1", "spqr-ratchet"];
pub const HELLO_MAX_CAPS: usize = 32;
pub const HELLO_MAX_CAP_LENGTH: usize = 64;
pub const HELLO_MAX_VERSION: u32 = 65535;
/// `[opcode][len:u32 BE][payload]`.
pub const FRAME_HEADER_BYTES: usize = 5;
/// Batas keras payload jalur bidi/handshake (32 KB).
pub const MAX_BIDI_PAYLOAD_BYTES: usize = 32768;

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TransportHello {
    pub v: u32,
    pub caps: Vec<String>,
}

/// Parse payload HELLO/ACK. `None` = bentuk tidak sah (diperlakukan legacy).
pub fn parse_transport_hello(raw: &[u8]) -> Option<TransportHello> {
    if raw.is_empty() || raw.len() > 4096 {
        return None;
    }
    let text = std::str::from_utf8(raw).ok()?;
    let parsed: TransportHello = serde_json::from_str(text).ok()?;
    if parsed.v < 1 || parsed.v > HELLO_MAX_VERSION {
        return None;
    }
    if parsed.caps.len() > HELLO_MAX_CAPS {
        return None;
    }
    if parsed
        .caps
        .iter()
        .any(|c| c.is_empty() || c.len() > HELLO_MAX_CAP_LENGTH)
    {
        return None;
    }
    Some(parsed)
}

/// Irisan kapabilitas klien↔server, urut sesuai daftar klien (deterministik).
pub fn negotiate_capabilities(client: &[String], server: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for cap in client {
        if server.contains(&cap.as_str()) && !out.contains(cap) {
            out.push(cap.clone());
        }
    }
    out
}

/// Frame `[opcode][len:u32 BE][payload]` untuk balasan HELLO.
///
/// Memakai opcode HELLO (0x0B), BUKAN ACK (0x06): 0x06 dipakai klien untuk
/// konfirmasi pesan (`resolve pendingAcks`) — mengirim JSON di sana akan
/// merusak jalur ACK.
pub fn hello_reply_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.push(HELLO_OPCODE);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Balasan standar: versi server + irisan kapabilitas.
pub fn hello_reply_payload(client_caps: &[String]) -> Vec<u8> {
    let reply = TransportHello {
        v: TRANSPORT_PROTOCOL_VERSION,
        caps: negotiate_capabilities(client_caps, &SERVER_CAPABILITIES),
    };
    serde_json::to_vec(&reply).unwrap_or_else(|_| b"{\"v\":1,\"caps\":[]}".to_vec())
}

/// Keputusan dari **header saja** (dipakai jalur bidi yang membaca payload
/// streaming: keputusan harus diambil sebelum payload masuk).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboundHeader {
    /// CHAFF (0x00) — dibuang tanpa diteruskan.
    Chaff,
    /// Panjang payload melebihi batas → dibuang (pemanggil boleh mencatat log).
    TooLarge,
    /// HELLO (0x0B) — negosiasi kapabilitas, tidak diteruskan ke Redis/Node.
    Hello,
    /// Pesan biasa: payload diteruskan ke `nyx:upstream:<opcode>`.
    Message,
}

/// Klasifikasikan frame dari `(op_code, length)`. `max_payload` = batas keras
/// panjang payload untuk jalur ini (`usize::MAX` = tanpa batas, mis. uni/datagram
/// yang panjangnya memang hanya dibatasi ukuran buffer).
///
/// Urutan sengaja CHAFF → batas → HELLO/pesan: chaff dibuang paling murah
/// (tanpa alokasi) dan panjang ekstrem ditolak sebelum payload dibaca.
pub fn classify_inbound(op_code: u8, length: usize, max_payload: usize) -> InboundHeader {
    if op_code == CHAFF_OPCODE {
        return InboundHeader::Chaff;
    }
    if length > max_payload {
        return InboundHeader::TooLarge;
    }
    if op_code == HELLO_OPCODE {
        return InboundHeader::Hello;
    }
    InboundHeader::Message
}

/// Hasil pembacaan satu frame utuh dari buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboundFrame<'a> {
    /// Header belum lengkap (< 5 byte).
    Incomplete,
    /// CHAFF — jangan diteruskan.
    Chaff,
    /// Panjang di header melebihi `max_payload`.
    TooLarge,
    /// Payload belum lengkap (atau panjang tidak masuk akal) di buffer.
    Truncated,
    /// HELLO — dipakai untuk negosiasi, tidak diteruskan.
    Hello(&'a [u8]),
    /// Pesan biasa: slice payload milik buffer (tanpa salinan).
    Forward { op_code: u8, payload: &'a [u8] },
}

impl<'a> InboundFrame<'a> {
    /// Payload yang boleh diteruskan? (`None` = frame ini tidak diteruskan.)
    pub fn forward_payload(self) -> Option<(u8, &'a [u8])> {
        match self {
            InboundFrame::Forward { op_code, payload } => Some((op_code, payload)),
            _ => None,
        }
    }
}

/// Baca satu frame dari buffer utuh (uni stream & datagram).
///
/// `max_payload` = batas keras payload (`usize::MAX` bila tak ada batas khusus).
/// Frame dengan panjang berlebih TIDAK pernah dipotong: hasilnya `TooLarge`
/// atau `Truncated`, jadi pemanggil tidak akan pernah mengirim payload sebagian.
/// Implementasi **referensi** untuk differential fuzzing (`fuzz.rs`): ditulis
/// ulang langsung dari spesifikasi (tanpa memanggil `classify_inbound`) supaya
/// dua implementasi yang berbeda bisa dibandingkan. Dua implementasi yang setuju
/// atas jutaan input acak jauh lebih meyakinkan daripada satu implementasi yang
/// diuji dengan contoh buatan tangan.
///
/// `None` = frame tidak boleh diteruskan (chaff/HELLO/terpotong/melebihi batas).
pub fn reference_forward(buf: &[u8], max_payload: usize) -> Option<(u8, Vec<u8>)> {
    if buf.len() < FRAME_HEADER_BYTES {
        return None;
    }
    let op_code = buf[0];
    if op_code == CHAFF_OPCODE {
        return None;
    }
    let length = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
    if length > max_payload {
        return None;
    }
    if op_code == HELLO_OPCODE {
        return None;
    }
    let end = match FRAME_HEADER_BYTES.checked_add(length) {
        Some(end) => end,
        None => return None,
    };
    if buf.len() < end {
        return None;
    }
    Some((op_code, buf[FRAME_HEADER_BYTES..end].to_vec()))
}

pub fn parse_inbound_frame(buf: &[u8], max_payload: usize) -> InboundFrame<'_> {
    if buf.len() < FRAME_HEADER_BYTES {
        return InboundFrame::Incomplete;
    }
    let op_code = buf[0];
    let length = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;

    match classify_inbound(op_code, length, max_payload) {
        InboundHeader::Chaff => return InboundFrame::Chaff,
        InboundHeader::TooLarge => return InboundFrame::TooLarge,
        InboundHeader::Hello | InboundHeader::Message => {}
    }

    // `checked_add` (bukan `+`) supaya panjang u32 maksimum tidak overflow di
    // target 32-bit: overflow = "tidak akan pernah lengkap" → Truncated.
    let end = match FRAME_HEADER_BYTES.checked_add(length) {
        Some(end) => end,
        None => return InboundFrame::Truncated,
    };
    if buf.len() < end {
        return InboundFrame::Truncated;
    }
    let payload = &buf[FRAME_HEADER_BYTES..end];
    if op_code == HELLO_OPCODE {
        InboundFrame::Hello(payload)
    } else {
        InboundFrame::Forward { op_code, payload }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(op_code: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![op_code];
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn parse_transport_hello_accepts_valid_payload() {
        let hello = parse_transport_hello(br#"{"v":1,"caps":["hello-v1","kt-lite"]}"#).unwrap();
        assert_eq!(hello.v, 1);
        assert_eq!(hello.caps, vec!["hello-v1".to_string(), "kt-lite".to_string()]);
    }

    #[test]
    fn parse_transport_hello_rejects_malformed_payload() {
        assert!(parse_transport_hello(b"").is_none(), "kosong");
        assert!(parse_transport_hello(b"bukan-json").is_none(), "bukan JSON");
        assert!(parse_transport_hello(br#"[1,2,3]"#).is_none(), "array, bukan object");
        assert!(parse_transport_hello(br#"{"v":0,"caps":[]}"#).is_none(), "versi 0");
        assert!(parse_transport_hello(br#"{"v":70000,"caps":[]}"#).is_none(), "versi di luar batas");
        assert!(parse_transport_hello(br#"{"v":"1","caps":[]}"#).is_none(), "versi bukan angka");
        assert!(parse_transport_hello(br#"{"v":1,"caps":"hello"}"#).is_none(), "caps bukan array");
        assert!(parse_transport_hello(br#"{"v":1,"caps":[""]}"#).is_none(), "cap kosong");
        // Cap kepanjangan / kebanyakan = tolak (anti-DoS).
        let long_cap = format!(r#"{{"v":1,"caps":["{}"]}}"#, "a".repeat(HELLO_MAX_CAP_LENGTH + 1));
        assert!(parse_transport_hello(long_cap.as_bytes()).is_none(), "cap > batas");
        let many: Vec<String> = (0..HELLO_MAX_CAPS + 1).map(|i| format!("\"c{i}\"")).collect();
        let many_payload = format!(r#"{{"v":1,"caps":[{}]}}"#, many.join(","));
        assert!(parse_transport_hello(many_payload.as_bytes()).is_none(), "caps > batas");
        // Payload > 4096 byte ditolak lebih dulu (tanpa parse JSON).
        let huge = vec![b' '; 4097];
        assert!(parse_transport_hello(&huge).is_none(), "payload > batas");
    }

    #[test]
    fn negotiate_capabilities_returns_intersection_in_client_order() {
        let client = vec!["kt-lite".to_string(), "hello-v1".to_string(), "experimental".to_string()];
        assert_eq!(negotiate_capabilities(&client, &SERVER_CAPABILITIES), vec!["hello-v1".to_string()]);
        // Kapabilitas tak dikenal TIDAK pernah masuk hasil.
        assert!(negotiate_capabilities(&client, &SERVER_CAPABILITIES).iter().all(|c| c != "experimental"));
        // Duplikat tidak menggandakan hasil.
        let dup = vec!["hello-v1".to_string(), "hello-v1".to_string()];
        assert_eq!(negotiate_capabilities(&dup, &SERVER_CAPABILITIES).len(), 1);
    }

    #[test]
    fn server_advertises_spqr_ratchet_as_deployment_switch() {
        // Klien baru yang menawarkan jalur v2 mendapatkannya kembali (irisan),
        // sementara klien lama (hanya hello-v1) tidak berubah perilakunya.
        let modern = vec!["hello-v1".to_string(), "spqr-ratchet".to_string()];
        assert_eq!(
            negotiate_capabilities(&modern, &SERVER_CAPABILITIES),
            vec!["hello-v1".to_string(), "spqr-ratchet".to_string()]
        );
        let legacy = vec!["hello-v1".to_string()];
        assert_eq!(
            negotiate_capabilities(&legacy, &SERVER_CAPABILITIES),
            vec!["hello-v1".to_string()]
        );
        let payload = hello_reply_payload(&modern);
        let parsed = parse_transport_hello(&payload).expect("balasan HELLO sah");
        assert!(parsed.caps.iter().any(|c| c == "spqr-ratchet"));
    }

    #[test]
    fn hello_reply_frame_shape_and_opcode() {
        let payload = hello_reply_payload(&["hello-v1".to_string()]);
        let frame_out = hello_reply_frame(&payload);
        assert_eq!(frame_out[0], HELLO_OPCODE, "balasan memakai opcode HELLO, bukan ACK");
        let len = u32::from_be_bytes([frame_out[1], frame_out[2], frame_out[3], frame_out[4]]) as usize;
        assert_eq!(len, payload.len());
        assert_eq!(&frame_out[5..], payload.as_slice());
        let parsed = parse_transport_hello(&frame_out[5..]).unwrap();
        assert_eq!(parsed.v, TRANSPORT_PROTOCOL_VERSION);
        assert_eq!(parsed.caps, vec!["hello-v1".to_string()]);
    }

    #[test]
    fn classify_orders_chaff_before_size_and_hello() {
        // CHAFF menang walau panjangnya ekstrem (dibuang paling murah).
        assert_eq!(classify_inbound(CHAFF_OPCODE, usize::MAX, 4096), InboundHeader::Chaff);
        // Panjang ekstrem & bukan chaff → TooLarge (bukan Hello).
        assert_eq!(classify_inbound(HELLO_OPCODE, 4097, 4096), InboundHeader::TooLarge);
        assert_eq!(classify_inbound(HELLO_OPCODE, 4096, 4096), InboundHeader::Hello);
        assert_eq!(classify_inbound(HANDSHAKE_OPCODE, 0, 4096), InboundHeader::Message);
        // Tanpa batas (uni/datagram): panjang u32 maksimum pun bukan TooLarge.
        assert_eq!(classify_inbound(0x11, u32::MAX as usize, usize::MAX), InboundHeader::Message);
    }

    #[test]
    fn parse_inbound_frame_covers_every_outcome() {
        assert_eq!(parse_inbound_frame(&[], usize::MAX), InboundFrame::Incomplete);
        assert_eq!(parse_inbound_frame(&[0x11, 0, 0], usize::MAX), InboundFrame::Incomplete);
        assert_eq!(parse_inbound_frame(&[CHAFF_OPCODE, 0, 0, 0, 0], usize::MAX), InboundFrame::Chaff);
        // CHAFF walau payload belum lengkap → tetap Chaff (dibuang).
        assert_eq!(
            parse_inbound_frame(&[CHAFF_OPCODE, 0, 0, 1, 0], usize::MAX),
            InboundFrame::Chaff
        );
        assert_eq!(parse_inbound_frame(&frame(0x11, b"abc"), 2), InboundFrame::TooLarge);
        assert_eq!(
            parse_inbound_frame(&frame(0x11, b"abc")[..6], usize::MAX),
            InboundFrame::Truncated
        );
        assert_eq!(
            parse_inbound_frame(&frame(HANDSHAKE_OPCODE, b"hi"), usize::MAX),
            InboundFrame::Forward { op_code: HANDSHAKE_OPCODE, payload: b"hi" }
        );
        assert_eq!(
            parse_inbound_frame(&frame(HELLO_OPCODE, b"{}"), usize::MAX),
            InboundFrame::Hello(b"{}")
        );
        // Panjang header u32 maksimum tanpa payload → Truncated (tidak overflow/panic).
        assert_eq!(
            parse_inbound_frame(&[0x11, 0xff, 0xff, 0xff, 0xff], usize::MAX),
            InboundFrame::Truncated
        );
        // Payload kosong tetap frame yang sah.
        assert_eq!(
            parse_inbound_frame(&frame(ACK_OPCODE, b""), usize::MAX),
            InboundFrame::Forward { op_code: ACK_OPCODE, payload: b"" }
        );
    }

    #[test]
    fn forward_payload_only_for_message_frames() {
        let buffer = frame(0x11, b"payload");
        let parsed = parse_inbound_frame(&buffer, usize::MAX);
        assert_eq!(parsed.forward_payload(), Some((0x11, b"payload".as_slice())));
        assert_eq!(parse_inbound_frame(&buffer[..1], usize::MAX).forward_payload(), None);
        assert_eq!(parse_inbound_frame(&frame(HELLO_OPCODE, b"{}"), usize::MAX).forward_payload(), None);
        assert_eq!(parse_inbound_frame(&frame(CHAFF_OPCODE, b"x"), usize::MAX).forward_payload(), None);
    }

}
