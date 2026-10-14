use anyhow::{Context, Result};
use dashmap::DashMap;
use dotenvy::dotenv;
use futures_util::StreamExt;
use jsonwebtoken::{decode, DecodingKey, Validation};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{error, info, warn};
use wtransport::{Connection, Endpoint, Identity, ServerConfig};
use bytes::{BufMut, BytesMut};

// ============================================================================
// [docs/29 §5.6 / docs/30 WS-G(5)] Negosiasi kapabilitas transport
// ============================================================================
//
// Klien mengirim HELLO (opcode 0x0B) pada stream bidi kontrol setelah
// terautentikasi; sidecar membalas dengan IRISAN kapabilitas yang dipahami
// KEDUANYA, dan TIDAK meneruskan frame ini ke Redis/Node (murni kontrol
// transport). Klien/sidecar lama tidak mengirim/menjawab → dianggap legacy
// (daftar kosong) tanpa perubahan perilaku.
//
// Keputusan murni (HELLO + bingkai `[opcode][len:u32 BE][payload]`) hidup di
// crate lib `protocol.rs` supaya bisa diuji/di-fuzz tanpa soket WebTransport
// nyata (`cargo test`, `cargo run --release --bin fuzz-framing`). Kontrak
// numeriknya tetap sinkron dengan `packages/shared/src/transport.ts`.
use transport_sidecar::protocol::{
    classify_inbound, hello_reply_frame, hello_reply_payload, parse_inbound_frame,
    parse_transport_hello, InboundFrame, InboundHeader, ACK_OPCODE, HANDSHAKE_OPCODE,
    MAX_BIDI_PAYLOAD_BYTES,
};

/// Batas keras WebTransport untuk `serverCertificateHashes`: Chrome menolak
/// sertifikat dengan rentang validitas > 14 hari (dan menolak yang sudah kedaluwarsa).
const WEBTRANSPORT_MAX_CERT_VALIDITY_DAYS: i64 = 14;
/// Masa berlaku sertifikat lokal yang kita terbitkan (10 hari, sesuai spesifikasi).
const LOCAL_CERT_VALIDITY_DAYS: i64 = 10;
/// Rotasi lebih awal: sertifikat yang tersisa < 1 hari dianggap perlu diganti.
const LOCAL_CERT_ROTATE_MARGIN_HOURS: i64 = 24;

const CERT_PATH: &str = "transport_cert.der";
const KEY_PATH: &str = "transport_key.der";

/// Sertifikat tersimpan masih layak dipakai untuk WebTransport lokal?
/// Mengembalikan `Err(alasan)` bila harus dirotasi — alasan dicatat di log.
fn local_cert_is_usable(cert_der: &[u8]) -> std::result::Result<(), String> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| format!("DER tidak bisa di-parse: {e}"))?;
    let validity = cert.validity();
    let not_before = validity.not_before.timestamp();
    let not_after = validity.not_after.timestamp();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let span_days = (not_after - not_before) / 86_400;

    if span_days > WEBTRANSPORT_MAX_CERT_VALIDITY_DAYS {
        return Err(format!(
            "rentang validitas {} hari > batas WebTransport {} hari",
            span_days, WEBTRANSPORT_MAX_CERT_VALIDITY_DAYS
        ));
    }
    if now < not_before {
        return Err("notBefore di masa depan (clock skew?)".to_string());
    }
    if now > not_after {
        return Err(format!("sudah kedaluwarsa {} jam lalu", (now - not_after) / 3600));
    }
    let remaining_hours = (not_after - now) / 3600;
    if remaining_hours < LOCAL_CERT_ROTATE_MARGIN_HOURS {
        return Err(format!("tersisa {} jam (< margin rotasi)", remaining_hours));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct Claims {
    id: Option<String>,
    sub: Option<String>,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct UpstreamMessage {
    user_id: String,
    device_id: String,
    op_code: u8,
    payload: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct DownstreamMessage {
    user_id: String,
    device_id: Option<String>,
    op_code: u8,
    is_datagram: bool,
    payload: String,
}

type SessionMap = Arc<DashMap<String, Arc<Connection>>>; // Key: "user_id:device_id"

#[cfg(test)]
mod cert_tests {
    use super::{local_cert_is_usable, LOCAL_CERT_VALIDITY_DAYS};

    /// Bangun sertifikat self-signed dengan offset validitas relatif ke sekarang.
    fn cert_with_offsets(not_before: time::Duration, not_after: time::Duration) -> Vec<u8> {
        let mut params =
            rcgen::CertificateParams::new(vec!["localhost".to_string(), "127.0.0.1".to_string()])
                .expect("params");
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now + not_before;
        params.not_after = now + not_after;
        let key_pair = rcgen::KeyPair::generate().expect("keypair");
        params.self_signed(&key_pair).expect("cert").der().to_vec()
    }

    #[test]
    fn fresh_local_cert_is_reused() {
        let cert = cert_with_offsets(
            -time::Duration::days(1),
            time::Duration::days(LOCAL_CERT_VALIDITY_DAYS),
        );
        assert!(local_cert_is_usable(&cert).is_ok());
    }

    #[test]
    fn expired_cert_is_rotated() {
        // Sertifikat warisan dari disk: kedaluwarsa beberapa hari lalu.
        let cert = cert_with_offsets(-time::Duration::days(30), -time::Duration::days(20));
        let err = local_cert_is_usable(&cert).expect_err("harus ditolak");
        assert!(err.contains("kedaluwarsa"), "alasan: {err}");
    }

    #[test]
    fn cert_near_expiry_is_rotated() {
        // Masih valid, tetapi sisa < margin rotasi (1 hari).
        let cert = cert_with_offsets(-time::Duration::days(10), time::Duration::hours(5));
        let err = local_cert_is_usable(&cert).expect_err("harus ditolak");
        assert!(err.contains("margin rotasi"), "alasan: {err}");
    }

    #[test]
    fn cert_with_span_over_webtransport_limit_is_rotated() {
        // Rentang 30 hari > batas keras Chrome (14 hari).
        let cert = cert_with_offsets(-time::Duration::days(1), time::Duration::days(29));
        let err = local_cert_is_usable(&cert).expect_err("harus ditolak");
        assert!(err.contains("batas WebTransport"), "alasan: {err}");
    }

    #[test]
    fn not_yet_valid_cert_is_rotated() {
        let cert = cert_with_offsets(time::Duration::days(2), time::Duration::days(9));
        let err = local_cert_is_usable(&cert).expect_err("harus ditolak");
        assert!(err.contains("notBefore"), "alasan: {err}");
    }

    #[test]
    fn garbage_bytes_are_rotated_not_fatal() {
        let err = local_cert_is_usable(b"not a certificate").expect_err("harus ditolak");
        assert!(err.contains("tidak bisa di-parse"), "alasan: {err}");
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let _ = dotenv();

    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| "secret".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());

    let prod_cert_path = std::env::var("PROD_CERT_PATH").unwrap_or_default();
    let prod_key_path = std::env::var("PROD_KEY_PATH").unwrap_or_default();

    let identity = if !prod_cert_path.is_empty() && !prod_key_path.is_empty() {
        info!("[PRODUCTION] Loading CA-signed PEM certificates from {}...", prod_cert_path);
        Identity::load_pemfiles(&prod_cert_path, &prod_key_path).await.context("Failed to load production PEM certificates")?
    } else {
        info!("[LOCAL] Loading/Generating persistent self-signed DER certificates...");
        let cert_path = CERT_PATH;
        let key_path = KEY_PATH;

        // Cetak path ABSOLUT: sertifikat dibaca relatif terhadap cwd, sehingga
        // menjalankan sidecar dari direktori lain menghasilkan sertifikat LAIN
        // (hash berbeda dari yang di-pin di web/.env) — sumber kebingungan nyata.
        let cert_abs = std::env::current_dir()
            .map(|d| d.join(cert_path).display().to_string())
            .unwrap_or_else(|_| cert_path.to_string());
        info!("Sertifikat lokal: {} (dibaca relatif ke cwd)", cert_abs);

        // Sertifikat lama DIPAKAI ULANG hanya bila masih valid sekarang, rentangnya
        // ≤ batas WebTransport, dan sisa masa berlakunya belum melewati margin.
        // Tanpa cek ini, sertifikat 10-hari yang tersimpan akan terus dipakai
        // sesudah kedaluwarsa → SETIAP koneksi WebTransport ditolak Chrome
        // (QUIC_TLS_CERTIFICATE_UNKNOWN) dan klien diam-diam jatuh ke fallback
        // WebSocket. Rotasi otomatis = pin `VITE_TRANSPORT_CERT_HASH` selalu
        // merujuk sertifikat yang benar-benar disajikan server.
        let existing = match (std::fs::read(cert_path), std::fs::read(key_path)) {
            (Ok(cert_der), Ok(key_der)) => match local_cert_is_usable(&cert_der) {
                Ok(()) => {
                    info!("Loading existing certificate from files...");
                    Some((cert_der, key_der))
                }
                Err(reason) => {
                    warn!("Sertifikat tersimpan tidak layak dipakai ({}). Sertifikat baru akan dibuat.", reason);
                    None
                }
            },
            _ => None,
        };

        let (cert_der, key_der) = if let Some(pair) = existing {
            pair
        } else {
            info!(
                "Generating new self-signed certificate (valid for {} days for WebTransport)...",
                LOCAL_CERT_VALIDITY_DAYS
            );
            let subject_alt_names = vec!["localhost".to_string(), "127.0.0.1".to_string()];

            let mut params = rcgen::CertificateParams::new(subject_alt_names).context("Failed to create cert params")?;
            let now = time::OffsetDateTime::now_utc();
            params.not_before = now - time::Duration::days(1);
            params.not_after = now + time::Duration::days(LOCAL_CERT_VALIDITY_DAYS);

            let key_pair = rcgen::KeyPair::generate().context("Failed to generate keypair")?;
            let cert = params.self_signed(&key_pair).context("Failed to create cert")?;
            let cert_der = cert.der().to_vec();
            let key_der = key_pair.serialize_der();

            std::fs::write(cert_path, &cert_der)?;
            std::fs::write(key_path, &key_der)?;
            (cert_der, key_der)
        };

        use wtransport::tls::{CertificateChain, PrivateKey, Certificate};
        let chain = CertificateChain::single(Certificate::from_der(cert_der).context("Failed to parse cert DER")?);
        let key = PrivateKey::from_der_pkcs8(key_der);
        Identity::new(chain, key)
    };

    let cert_hash = identity.certificate_chain().as_slice()[0].hash();
    info!("╔══════════════════════════════════════════════════════════════════════════════╗");
    info!("║ WEBTRANSPORT LOCALHOST CONFIGURATION                                         ║");
    info!("╠══════════════════════════════════════════════════════════════════════════════╣");
    info!("║ SHA-256 Hash: {} ║", cert_hash.to_string());
    info!("║                                                                              ║");
    info!("║ Add this to your web/.env file:                                              ║");
    info!("║ VITE_TRANSPORT_CERT_HASH={} ║", cert_hash.to_string());
    info!("╚══════════════════════════════════════════════════════════════════════════════╝");
    info!(
        "Pastikan web/.env → VITE_TRANSPORT_CERT_HASH sama dengan hash di atas, lalu restart `vite dev`."
    );

    let port: u16 = std::env::var("TRANSPORT_PORT")
        .unwrap_or_else(|_| "33333".to_string())
        .parse()
        .expect("TRANSPORT_PORT harus berupa angka port yang valid");

    let bind_addr: std::net::SocketAddr = format!("0.0.0.0:{}", port)
        .parse()
        .expect("Gagal mem-parsing bind address");

    info!("🚀 WebTransport Sidecar bersiap di {}", bind_addr);

    let config = ServerConfig::builder()
        .with_bind_address(bind_addr)
        .with_identity(identity)
        .build();

    let server = Endpoint::server(config).context("Failed to create server")?;
    
    let sessions: SessionMap = Arc::new(DashMap::new());

    // Redis
    let redis_client = redis::Client::open(redis_url.clone())?;
    let pub_conn = redis_client.get_multiplexed_tokio_connection().await?;
    let redis_url_clone = redis_url.clone();
    let sessions_clone = sessions.clone();
    tokio::spawn(async move {
        loop {
            let mut pubsub = match redis::Client::open(redis_url_clone.clone()) {
                Ok(client) => match client.get_async_pubsub().await {
                    Ok(ps) => ps,
                    Err(e) => {
                        error!("Failed to get async pubsub: {:?}. Retrying in 3s...", e);
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        continue;
                    }
                },
                Err(e) => {
                    error!("Failed to open redis client: {:?}. Retrying in 3s...", e);
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    continue;
                }
            };

            if let Err(e) = pubsub.subscribe("nyx:downstream").await {
                error!("Failed to subscribe to nyx:downstream: {:?}. Retrying in 3s...", e);
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                continue;
            }

            info!("Successfully subscribed to nyx:downstream");
            let mut stream = pubsub.on_message();
            
            while let Some(msg) = stream.next().await {
                let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                let down_msg: DownstreamMessage = match serde_json::from_str(&payload) {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                let payload_bytes = match data_encoding::BASE64URL_NOPAD.decode(down_msg.payload.as_bytes()) {
                    Ok(b) => b,
                    Err(_) => match data_encoding::BASE64.decode(down_msg.payload.as_bytes()) {
                        Ok(b) => b,
                        Err(_) => continue,
                    }
                };

                if let Some(target_device) = down_msg.device_id {
                    let prefix = format!("{}:{}:", down_msg.user_id, target_device);
                    for item in sessions_clone.iter().filter(|i| i.key().starts_with(&prefix)) {
                        let conn = item.value().clone();
                        let op_code = down_msg.op_code;
                        let payload_clone = payload_bytes.clone();

                        if op_code == 0x07 { // KICK
                            conn.close(1000u32.into(), b"Kicked by server");
                            continue;
                        }

                        tokio::spawn(async move {
                            let mut frame = BytesMut::with_capacity(5 + payload_clone.len());
                            frame.put_u8(op_code);
                            frame.put_u32(payload_clone.len() as u32);
                            frame.put_slice(&payload_clone);

                            if down_msg.is_datagram {
                                let _ = conn.send_datagram(frame.freeze());
                            } else {
                                if let Ok(opening) = conn.open_uni().await {
                                    let _ = tokio::spawn(async move {
                                        if let Ok(mut stream) = opening.await {
                                            let _ = stream.write_all(&frame).await;
                                            let _ = stream.finish().await;
                                        }
                                    });
                                }
                            }
                        });
                    }
                } else {
                    // Broadcast to all devices of this user
                    let prefix = format!("{}:", down_msg.user_id);
                    for item in sessions_clone.iter().filter(|i| i.key().starts_with(&prefix)) {
                        let conn = item.value().clone();
                        let op_code = down_msg.op_code;
                        let payload_clone = payload_bytes.clone();
                        
                        if op_code == 0x07 { // KICK
                            conn.close(1000u32.into(), b"Kicked by server");
                            continue;
                        }

                        tokio::spawn(async move {
                            let mut frame = BytesMut::with_capacity(5 + payload_clone.len());
                            frame.put_u8(op_code);
                            frame.put_u32(payload_clone.len() as u32);
                            frame.put_slice(&payload_clone);

                            if down_msg.is_datagram {
                                let _ = conn.send_datagram(frame.freeze());
                            } else {
                                if let Ok(opening) = conn.open_uni().await {
                                    let _ = tokio::spawn(async move {
                                        if let Ok(mut stream) = opening.await {
                                            let _ = stream.write_all(&frame).await;
                                            let _ = stream.finish().await;
                                        }
                                    });
                                }
                            }
                        });
                    }
                }
            }
            
            warn!("Redis downstream stream ended. Attempting to reconnect in 3s...");
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });

    info!("WebTransport Sidecar Listening on 33333");

    let server = Arc::new(server);

    loop {
        let incoming = server.accept().await;
        let sessions = sessions.clone();
        let pub_conn = pub_conn.clone();
        let jwt_secret = jwt_secret.clone();
        
        tokio::spawn(async move {
            match incoming.await {
                Ok(req) => {
                    // 1. Extract Ticket from URL (Hybrid Auth for Brave/Safari)
                    let full_path = req.path();
                    let mut ticket_user_id = None;
                    let mut ticket_device_id = None;

                    if let Ok(base_url) = url::Url::parse("https://localhost") {
                        if let Ok(url) = base_url.join(full_path) {
                            for (key, value) in url.query_pairs() {
                                if key == "ticket" {
                                    let mut val = Validation::new(jsonwebtoken::Algorithm::HS256);
                                    val.validate_exp = true;
                                    val.required_spec_claims.insert("exp".to_string());

                                    if let Ok(token_data) = decode::<Claims>(&*value, &DecodingKey::from_secret(jwt_secret.as_bytes()), &val) {
                                        ticket_user_id = token_data.claims.id.or(token_data.claims.sub);
                                        ticket_device_id = token_data.claims.device_id;
                                    }
                                    break;
                                }
                            }
                        }
                    }

                    match req.accept().await {
                        Ok(conn) => {
                            if let Err(e) = handle_connection(conn, sessions, pub_conn, jwt_secret, ticket_user_id, ticket_device_id).await {
                                warn!("Conn error: {:?}", e);
                            }
                        }
                        Err(e) => warn!("Accept conn error: {:?}", e)
                    }
                }
                Err(e) => warn!("Incoming error: {:?}", e)
            }
        });
    }
}

async fn handle_connection(
    conn: Connection,
    sessions: SessionMap,
    mut pub_conn: redis::aio::MultiplexedConnection,
    jwt_secret: String,
    ticket_user_id: Option<String>,
    ticket_device_id: Option<String>,
) -> Result<()> {
    let (user_id, device_id) = if let (Some(uid), Some(did)) = (ticket_user_id, ticket_device_id) {
        info!("User {} authenticated via URL Ticket", uid);
        (uid, did)
    } else {
        // Fallback: First bidirectional stream is for Authentication
        let (mut _auth_send, mut auth_recv) = conn.accept_bi().await.context("auth_accept_bi")?;
        
        let mut auth_header = [0u8; 5];
        let mut read_bytes = 0;
        while read_bytes < 5 {
            let n = auth_recv.read(&mut auth_header[read_bytes..]).await.context("auth_header")?.unwrap_or(0);
            if n == 0 { break; }
            read_bytes += n;
        }
        
        let auth_length = u32::from_be_bytes([auth_header[1], auth_header[2], auth_header[3], auth_header[4]]) as usize;
        if auth_length > 4096 { return Err(anyhow::anyhow!("Token too large")); }

        let mut token_bytes = vec![0u8; auth_length];
        read_bytes = 0;
        while read_bytes < auth_length {
            let n = auth_recv.read(&mut token_bytes[read_bytes..]).await.context("auth_token")?.unwrap_or(0);
            if n == 0 { break; }
            read_bytes += n;
        }
        
        let token = String::from_utf8(token_bytes).unwrap_or_default();
        let mut val = Validation::new(jsonwebtoken::Algorithm::HS256);
        val.validate_exp = true;
        val.required_spec_claims.insert("exp".to_string());

        let token_data = match decode::<Claims>(&token, &DecodingKey::from_secret(jwt_secret.as_bytes()), &val) {
            Ok(data) => data,
            Err(e) => {
                warn!("JWT Decode failed: {}", e);
                return Err(anyhow::anyhow!("Unauthorized"));
            }
        };
        
        let uid = match token_data.claims.id.or(token_data.claims.sub) {
            Some(id) => id,
            None => {
                warn!("JWT missing id/sub claim");
                return Err(anyhow::anyhow!("Unauthorized: Missing ID"));
            }
        };
        let did = token_data.claims.device_id.unwrap_or_else(|| "unknown".to_string());
        info!("User {} authenticated via BWH-V1 Stream", uid);
        (uid, did)
    };

    info!("User {} (device {}) finalized authentication", user_id, device_id);

    // Enforce "One User, One Active Device"
    let user_prefix = format!("{}:", user_id);
    let mut sessions_to_kick = Vec::new();
    
    // Find all active sessions for this user
    for item in sessions.iter() {
        if item.key().starts_with(&user_prefix) {
            sessions_to_kick.push(item.key().clone());
        }
    }

    // Kick existing sessions
    for old_key in sessions_to_kick {
        if let Some((_, old_conn)) = sessions.remove(&old_key) {
            info!("Kicking existing session for user {}: {}", user_id, old_key);
            // Close with reason (1000 is generic closure, could use a custom app code)
            old_conn.close(1000u32.into(), b"Logged in on another device");
        }
    }

    let session_uuid = uuid::Uuid::new_v4().to_string();
    let session_key = format!("{}:{}:{}", user_id, device_id, session_uuid);
    
    let conn = Arc::new(conn);
    sessions.insert(session_key.clone(), conn.clone());

    // 2. Continuous Bidirectional Stream Loop (for Handshakes, etc.)
    let c_bi = conn.clone();
    let user_id_bi = user_id.clone();
    let device_id_bi = device_id.clone();
    let p_bi = pub_conn.clone();
    tokio::spawn(async move {
        loop {
            match c_bi.accept_bi().await {
                Ok((mut send, mut recv)) => {
                    let mut p = p_bi.clone();
                    let uid = user_id_bi.clone();
                    let did = device_id_bi.clone();
                    tokio::spawn(async move {
                        let mut header = [0u8; 5];
                        let mut head_read = 0;
                        while head_read < 5 {
                            match recv.read(&mut header[head_read..]).await {
                                Ok(Some(n)) if n > 0 => head_read += n,
                                _ => return, // Stream closed or error
                            }
                        }

                        let op_code = header[0];
                        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;

                        // [docs/30 WS-G(5)] Keputusan dipakai bersama jalur
                        // uni/datagram: CHAFF dibuang, > 32 KB ditolak, HELLO
                        // dikenali — semuanya lewat `protocol::classify_inbound`.
                        let header_kind = classify_inbound(op_code, length, MAX_BIDI_PAYLOAD_BYTES);
                        match header_kind {
                            InboundHeader::Chaff => return,
                            InboundHeader::TooLarge => {
                                warn!("Payload too large: {} bytes", length);
                                return;
                            }
                            InboundHeader::Hello | InboundHeader::Message => {}
                        }

                        let mut payload = vec![0u8; length];
                        let mut read = 0;
                        while read < length {
                            match recv.read(&mut payload[read..]).await {
                                Ok(Some(n)) if n > 0 => read += n,
                                _ => break,
                            }
                        }

                        if read == length {
                            // [docs/29 §5.6] Negosiasi kapabilitas: transport-local,
                            // TIDAK diteruskan ke Redis/Node. Balas dengan versi
                            // server + irisan kapabilitas.
                            if header_kind == InboundHeader::Hello {
                                match parse_transport_hello(&payload) {
                                    Some(hello) => {
                                        let reply = hello_reply_payload(&hello.caps);
                                        let _ = send.write_all(&hello_reply_frame(&reply)).await;
                                        info!(
                                            "HELLO dari user {} (v{}, {} cap) → dijawab {} cap",
                                            uid,
                                            hello.v,
                                            hello.caps.len(),
                                            parse_transport_hello(&reply).map(|r| r.caps.len()).unwrap_or(0)
                                        );
                                    }
                                    None => {
                                        warn!("HELLO tidak sah dari user {} — diabaikan (legacy)", uid);
                                    }
                                }
                                return;
                            }

                            let b64_payload = data_encoding::BASE64URL_NOPAD.encode(&payload);
                            let msg = UpstreamMessage {
                                user_id: uid,
                                device_id: did,
                                op_code,
                                payload: b64_payload,
                            };
                            
                            if let Ok(json) = serde_json::to_string(&msg) {
                                let channel = format!("nyx:upstream:{}", op_code);
                                let _: Result<(), _> = p.publish(channel, json).await;

                                // For HANDSHAKE, send back immediate ACK to client
                                if op_code == HANDSHAKE_OPCODE {
                                    let ack_frame = [ACK_OPCODE, 0, 0, 0, 0]; // ACK OpCode + 0 length
                                    let _ = send.write_all(&ack_frame).await;
                                }
                            }
                        }
                    });
                }
                Err(_) => break,
            }
        }
    });

    // 3. Unidirectional Stream Loop (for legacy/bulk data)
    let c2 = conn.clone();
    let user_id2 = user_id.clone();
    let device_id2 = device_id.clone();
    let p2 = pub_conn.clone();
    tokio::spawn(async move {
        loop {
            match c2.accept_uni().await {
                Ok(mut stream) => {
                    let mut p = p2.clone();
                    let uid = user_id2.clone();
                    let did = device_id2.clone();
                    tokio::spawn(async move {
                        let mut buffer = Vec::new();
                        let mut chunk = [0u8; 4096];
                        while let Ok(Some(n)) = stream.read(&mut chunk).await {
                            buffer.extend_from_slice(&chunk[..n]);
                        }
                        
                        // [docs/30 WS-G(5)] Parser murni untuk buffer utuh: CHAFF,
                        // HELLO, dan frame terpotong TIDAK pernah diteruskan ke
                        // `nyx:upstream:*` (opcode transport-local bocor = regresi).
                        match parse_inbound_frame(&buffer, usize::MAX) {
                            InboundFrame::Forward { op_code, payload } => {
                                let b64_payload = data_encoding::BASE64URL_NOPAD.encode(payload);

                                let msg = UpstreamMessage {
                                    user_id: uid,
                                    device_id: did,
                                    op_code,
                                    payload: b64_payload,
                                };

                                if let Ok(json) = serde_json::to_string(&msg) {
                                    let channel = format!("nyx:upstream:{}", op_code);
                                    let _: Result<(), _> = p.publish(channel, json).await;
                                }
                            }
                            // [docs/29 §5.6] HELLO hanya sah di stream BIDI (butuh
                            // balasan irisan kapabilitas).
                            InboundFrame::Hello(_) => {
                                warn!("HELLO di stream uni dari user {} — diabaikan (harus bidi)", uid);
                            }
                            _ => {}
                        }
                    });
                }
                Err(_) => break,
            }
        }
    });

    let c3 = conn.clone();
    let user_id3 = user_id.clone();
    let device_id3 = device_id.clone();
    let mut p3 = pub_conn.clone();
    tokio::spawn(async move {
        loop {
            match c3.receive_datagram().await {
                Ok(datagram) => {
                    // [docs/30 WS-G(5)] Parser murni yang sama dengan jalur uni.
                    match parse_inbound_frame(&datagram, usize::MAX) {
                        InboundFrame::Forward { op_code, payload } => {
                            let b64_payload = data_encoding::BASE64URL_NOPAD.encode(payload);

                            let msg = UpstreamMessage {
                                user_id: user_id3.clone(),
                                device_id: device_id3.clone(),
                                op_code,
                                payload: b64_payload,
                            };

                            if let Ok(json) = serde_json::to_string(&msg) {
                                let channel = format!("nyx:upstream:{}", op_code);
                                let _: Result<(), _> = p3.publish(channel, json).await;
                            }
                        }
                        // [docs/29 §5.6] HELLO tidak pernah valid di datagram
                        // (tidak ada balasan di jalur ini) — jangan diteruskan.
                        InboundFrame::Hello(_) => {
                            warn!("HELLO di datagram dari user {} — diabaikan (harus bidi)", user_id3);
                        }
                        _ => {}
                    }
                }
                Err(_) => break,
            }
        }
    });

    conn.closed().await;
    sessions.remove(&session_key);

    // Notify Node.js backend about disconnect (OpCode 99)
    let disconnect_msg = UpstreamMessage {
        user_id: user_id.clone(),
        device_id: device_id.clone(),
        op_code: 99,
        payload: "".to_string(),
    };
    if let Ok(json) = serde_json::to_string(&disconnect_msg) {
        let _: Result<(), _> = pub_conn.publish("nyx:upstream:99", json).await;
    }

    info!("User {} (device {}) disconnected", user_id, device_id);
    Ok(())
}
