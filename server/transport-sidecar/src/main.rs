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
        let cert_path = "transport_cert.der";
        let key_path = "transport_key.der";

        let (cert_der, key_der) = if std::path::Path::new(cert_path).exists() && std::path::Path::new(key_path).exists() {
            info!("Loading existing certificate from files...");
            // WebTransport requires local certs to be valid for <= 14 days. 
            // Rather than trying to parse expiration here, we'll just use it,
            // but if it fails to connect, users can delete the .der files.
            (std::fs::read(cert_path)?, std::fs::read(key_path)?)
        } else {
            info!("Generating new self-signed certificate (valid for 10 days for WebTransport)...");
            let subject_alt_names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
            
            let mut params = rcgen::CertificateParams::new(subject_alt_names).context("Failed to create cert params")?;
            let now = time::OffsetDateTime::now_utc();
            params.not_before = now - time::Duration::days(1);
            params.not_after = now + time::Duration::days(10);
            
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
                    match req.accept().await {
                        Ok(conn) => {
                            if let Err(e) = handle_connection(conn, sessions, pub_conn, jwt_secret).await {
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
) -> Result<()> {
    // 1. First bidirectional stream is ALWAYS for Authentication
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
    let val = Validation::new(jsonwebtoken::Algorithm::HS256);
    let token_data = match decode::<Claims>(&token, &DecodingKey::from_secret(jwt_secret.as_bytes()), &val) {
        Ok(data) => data,
        Err(e) => {
            warn!("JWT Decode failed: {}", e);
            return Err(anyhow::anyhow!("Unauthorized"));
        }
    };
    
    let user_id = match token_data.claims.id.or(token_data.claims.sub) {
        Some(id) => id,
        None => {
            warn!("JWT missing id/sub claim");
            return Err(anyhow::anyhow!("Unauthorized: Missing ID"));
        }
    };
    let device_id = token_data.claims.device_id.unwrap_or_else(|| "unknown".to_string());

    info!("User {} (device {}) authenticated via WebTransport", user_id, device_id);

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
                        
                        // MAX 32KB for Handshake/Bi-stream payloads
                        if length > 32768 {
                            warn!("Payload too large: {} bytes", length);
                            return;
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

                                // For HANDSHAKE (0x0A), send back immediate ACK to client
                                if op_code == 0x0A {
                                    let ack_frame = [0x06, 0, 0, 0, 0]; // ACK OpCode + 0 length
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
                        
                        if buffer.len() >= 5 {
                            let op_code = buffer[0];
                            let length = u32::from_be_bytes([buffer[1], buffer[2], buffer[3], buffer[4]]) as usize;
                            if buffer.len() >= 5 + length {
                                let payload = &buffer[5..5+length];
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
                    if datagram.len() >= 5 {
                        let op_code = datagram[0];
                        let length = u32::from_be_bytes([datagram[1], datagram[2], datagram[3], datagram[4]]) as usize;
                        if datagram.len() >= 5 + length {
                            let payload = &datagram[5..5+length];
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
