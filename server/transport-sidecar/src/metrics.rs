// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

//! [docs/30 WS-G(6)] Metrik sidecar WebTransport — **murni** (tanpa soket),
//! seperti `protocol.rs`, supaya bisa diuji `cargo test` di mesin mana pun.
//!
//! Kenapa modul ini ada: sebelum 2026-10-17 sidecar adalah satu-satunya proses
//! NYX yang tidak mengekspos `/metrics`, jadi satu-satunya cara tahu "berapa
//! klien benar-benar memakai WebTransport, dan berapa banyak yang ditolak" adalah
//! membaca log — padahal klien yang gagal handshake **jatuh ke WSS secara
//! senyap** (`web/src/lib/transportMode.ts`): tidak ada error di mana pun yang
//! memberi tahu bahwa jalur cepatnya sedang mati.
//!
//! Aturan yang sama dengan `server/src/utils/metrics.ts` dan
//! `server/kt-query/cmd/nyx-kt-auditor/metrics.go` (docs/30 §30.1 poin 4):
//! metrik hanya berisi **hitungan event dengan label enum yang ditulis di kode**.
//! Di sini aturan itu ditegakkan secara struktural: label adalah literal di
//! dalam tabel `*_LABELS`, dan nilai diambil lewat indeks yang sama dengan
//! `E::index()` — tidak ada jalur untuk menyuntikkan nilai runtime (userId,
//! deviceId, IP) ke time series.
//!
//! `METRIC_DEFS` adalah satu-satunya sumber kebenaran, dan
//! `scripts/drill-alerts.sh` membacanya untuk memastikan setiap metrik
//! `nyx_transport_*` yang dirujuk `ops/prometheus/alerts.yml` benar-benar ada —
//! nama yang salah tulis = aturan yang tidak akan pernah menyala.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// Hasil satu koneksi masuk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionOutcome {
    /// Handshake WebTransport (QUIC/TLS) selesai dan sesi diterima.
    Accepted,
    /// Handshake ditolak (mis. tiket/sertifikat tidak sah di sisi klien).
    Rejected,
    /// Koneksi gagal sebelum handshake selesai.
    Failed,
}

impl ConnectionOutcome {
    fn label(self) -> &'static str {
        match self {
            ConnectionOutcome::Accepted => "accepted",
            ConnectionOutcome::Rejected => "rejected",
            ConnectionOutcome::Failed => "failed",
        }
    }

    fn index(self) -> usize {
        match self {
            ConnectionOutcome::Accepted => 0,
            ConnectionOutcome::Rejected => 1,
            ConnectionOutcome::Failed => 2,
        }
    }

    const ALL: [ConnectionOutcome; 3] = [
        ConnectionOutcome::Accepted,
        ConnectionOutcome::Rejected,
        ConnectionOutcome::Failed,
    ];
}

/// Cara klien terautentikasi: `ticket` = JWT di query URL (jalur cepat),
/// `bwh` = stream bidi pertama (jalur cadangan).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    Ticket,
    Bwh,
}

impl AuthMethod {
    fn label(self) -> &'static str {
        match self {
            AuthMethod::Ticket => "ticket",
            AuthMethod::Bwh => "bwh",
        }
    }

    fn index(self) -> usize {
        match self {
            AuthMethod::Ticket => 0,
            AuthMethod::Bwh => 1,
        }
    }

    const ALL: [AuthMethod; 2] = [AuthMethod::Ticket, AuthMethod::Bwh];
}

/// Alasan autentikasi gagal. Semuanya enum: tidak ada userId/token yang ikut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFailure {
    /// Tiket di URL ada tetapi tidak bisa diverifikasi (kedaluwarsa/tanda tangan).
    TicketInvalid,
    /// Stream autentikasi mengirim token > 4 KiB (batas keras protokol).
    TokenTooLarge,
    /// JWT tidak bisa didekode (tanda tangan/exp tidak sah).
    BwhInvalid,
    /// JWT sah tetapi tidak memuat `id`/`sub`.
    NoIdentifier,
}

impl AuthFailure {
    fn label(self) -> &'static str {
        match self {
            AuthFailure::TicketInvalid => "ticket_invalid",
            AuthFailure::TokenTooLarge => "token_too_large",
            AuthFailure::BwhInvalid => "bwh_invalid",
            AuthFailure::NoIdentifier => "no_identifier",
        }
    }

    fn index(self) -> usize {
        match self {
            AuthFailure::TicketInvalid => 0,
            AuthFailure::TokenTooLarge => 1,
            AuthFailure::BwhInvalid => 2,
            AuthFailure::NoIdentifier => 3,
        }
    }

    const ALL: [AuthFailure; 4] = [
        AuthFailure::TicketInvalid,
        AuthFailure::TokenTooLarge,
        AuthFailure::BwhInvalid,
        AuthFailure::NoIdentifier,
    ];
}

/// Jalur inbound tempat frame diterima.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Path {
    Bidi,
    Uni,
    Datagram,
}

impl Path {
    fn label(self) -> &'static str {
        match self {
            Path::Bidi => "bidi",
            Path::Uni => "uni",
            Path::Datagram => "datagram",
        }
    }

    fn index(self) -> usize {
        match self {
            Path::Bidi => 0,
            Path::Uni => 1,
            Path::Datagram => 2,
        }
    }

    const ALL: [Path; 3] = [Path::Bidi, Path::Uni, Path::Datagram];
}

/// Frame yang dibuang sebelum diteruskan ke Redis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// Opcode 0x00 (CHAFF): padding penyamaran trafik, memang harus dibuang.
    Chaff,
    /// Payload melewati batas protokol.
    TooLarge,
    /// Frame terpotong/rusak menurut parser murni `protocol.rs`.
    Malformed,
    /// HELLO di jalur yang tidak bisa menjawab (uni/datagram).
    HelloWrongPath,
}

impl RejectReason {
    fn label(self) -> &'static str {
        match self {
            RejectReason::Chaff => "chaff",
            RejectReason::TooLarge => "too_large",
            RejectReason::Malformed => "malformed",
            RejectReason::HelloWrongPath => "hello_wrong_path",
        }
    }

    fn index(self) -> usize {
        match self {
            RejectReason::Chaff => 0,
            RejectReason::TooLarge => 1,
            RejectReason::Malformed => 2,
            RejectReason::HelloWrongPath => 3,
        }
    }

    const ALL: [RejectReason; 4] = [
        RejectReason::Chaff,
        RejectReason::TooLarge,
        RejectReason::Malformed,
        RejectReason::HelloWrongPath,
    ];
}

/// Hasil satu pesan `nyx:downstream` dari Redis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownstreamOutcome {
    /// Diteruskan ke minimal satu sesi.
    Delivered,
    /// Tidak ada sesi yang cocok (perangkat sudah lepas).
    NoSession,
    /// Payload rusak/tidak bisa didekode — dibuang.
    Dropped,
}

impl DownstreamOutcome {
    fn label(self) -> &'static str {
        match self {
            DownstreamOutcome::Delivered => "delivered",
            DownstreamOutcome::NoSession => "no_session",
            DownstreamOutcome::Dropped => "dropped",
        }
    }

    fn index(self) -> usize {
        match self {
            DownstreamOutcome::Delivered => 0,
            DownstreamOutcome::NoSession => 1,
            DownstreamOutcome::Dropped => 2,
        }
    }

    const ALL: [DownstreamOutcome; 3] = [
        DownstreamOutcome::Delivered,
        DownstreamOutcome::NoSession,
        DownstreamOutcome::Dropped,
    ];
}

/// Arah byte yang dihitung: `in` = dari klien, `out` = ke klien.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

impl Direction {
    fn label(self) -> &'static str {
        match self {
            Direction::In => "in",
            Direction::Out => "out",
        }
    }

    fn index(self) -> usize {
        match self {
            Direction::In => 0,
            Direction::Out => 1,
        }
    }

    const ALL: [Direction; 2] = [Direction::In, Direction::Out];
}

// ============================================================================
// Pembentukan sampel berlabel
// ============================================================================
//
// Nama label adalah literal di deklarasi metrik ("result", "method", "path",
// "reason", "direction"), sedangkan NILAI label datang dari `E::label()` — match
// atas enum, jadi tidak ada jalur bagi nilai runtime (userId, deviceId, IP)
// untuk masuk ke time series. Indeks counter dan nilai label diambil dari varian
// yang sama (`E::index()` + `E::label()`), sehingga urutan keduanya tidak mungkin
// berbeda.

/// Satu metrik: nama, tipe, help, dan cara mengambil sampelnya.
///
/// `samples` menerima `&TransportMetrics` dan mengembalikan pasangan
/// `(teks label, nilai)`.
pub struct MetricDef {
    pub name: &'static str,
    pub kind: &'static str,
    pub help: &'static str,
    pub samples: fn(&TransportMetrics) -> Vec<(String, u64)>,
}

// ============================================================================
// Histogram (latensi jalur) — dukungan minimal, tanpa dependency
// ============================================================================
//
// Kenapa histogram, bukan counter "berapa frame yang lebih lambat dari X ms":
// yang dicari bukan jumlah kejadian, melainkan **bentuk distribusinya**
// (p50/p95/p99). Ambang keras pada counter hanya bisa menjawab "ada N frame di
// atas X ms" — dan pada laju rendah jawabannya selalu "nol" sampai jalurnya
// benar-benar rusak. Histogram menunjukkan pergeseran distribusi (p95 naik dari
// 1 ms ke 20 ms) ketika semuanya masih "jalan", yaitu tepat saat satu-satunya
// kesempatan untuk bertindak sebelum jalur cepatnya mati (docs/10 §10.12).
//
// Bucket bersifat KUMULATIF seperti konvensi Prometheus: bucket ke-i menghitung
// observasi `<= buckets[i]`. Seluruh bucket dirender bernilai 0 sejak proses
// hidup (`_count` = 0), jadi `rate(..._count[5m])` bernilai **0**, bukan "No data"
// — dan aturan alert bisa memakai laju itu sebagai penjaga "ada trafik sama
// sekali". (`histogram_quantile` atas histogram tanpa observasi tetap NaN; itu
// memang artinya "belum ada sampel", bukan "nol detik".)

/// Snapshot satu deret histogram: label tambahan (di luar `le`), jumlah
/// kumulatif per bucket, jumlah observasi, dan total dalam **mikrodetik**.
///
/// Total disimpan sebagai bilangan bulat mikrodetik, bukan `f64`: `AtomicU64`
/// memungkinkan penjumlahan tanpa kunci, dan tidak ada galat pembulatan yang
/// berbeda-beda antar-scrape. Presisi mikrodetik jauh di atas kebutuhan latensi
/// hop (yang diukur dalam milidetik).
pub struct HistogramSnapshot {
    /// Teks label tambahan, mis. `{path="bidi"}`; kosong = tanpa label.
    pub labels: String,
    /// Jumlah kumulatif per bucket (panjangnya = `buckets.len()`).
    pub buckets: Vec<u64>,
    pub count: u64,
    pub sum_micros: u64,
}

/// Deklarasi satu metrik histogram. Terpisah dari `MetricDef` karena bentuk
/// sampelnya berbeda (bucket + sum + count, bukan satu nilai) — memaksakannya ke
/// dalam satu struct berarti dua medan opsional yang saling meniadakan.
pub struct HistogramDef {
    pub name: &'static str,
    pub help: &'static str,
    pub buckets: &'static [f64],
    pub samples: fn(&TransportMetrics) -> Vec<HistogramSnapshot>,
}

/// Batas bucket latensi hop (detik).
///
/// Rentangnya dimulai 1 ms: hop sidecar yang sehat ada di ratusan mikrodetik,
/// jadi bucket pertama sudah cukup untuk membedakan "normal" dari "mulai
/// melambat". Batas atas 2,5 s menandai "tidak layak dipakai" — dan
/// `histogram_quantile` mengembalikan batas bucket berhingga tertinggi bila
/// kuantilnya jatuh di `+Inf`, sehingga nilai ekstrem tidak pernah menyamar
/// sebagai angka kecil.
pub const INGRESS_BUCKETS: &[f64] = &[
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5,
];

/// Histogram atomik tanpa label: semua observasi masuk satu deret.
pub struct Histogram {
    buckets: &'static [f64],
    counts: Vec<AtomicU64>,
    sum_micros: AtomicU64,
    count: AtomicU64,
}

impl Histogram {
    fn new(buckets: &'static [f64]) -> Self {
        Self {
            buckets,
            counts: (0..buckets.len()).map(|_| AtomicU64::new(0)).collect(),
            sum_micros: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }

    /// Catat satu observasi (detik).
    ///
    /// Nilai non-finit atau negatif **dibuang**, bukan dijepit ke 0: satu `NaN`
    /// yang lolos (mis. dari pembagian oleh nol di suatu jalur) akan meracuni
    /// p95 selama-lamanya, dan metrik yang salah lebih buruk daripada metrik
    /// yang tidak ada.
    pub fn observe_seconds(&self, seconds: f64) {
        if !seconds.is_finite() || seconds < 0.0 {
            return;
        }
        for (index, bound) in self.buckets.iter().enumerate() {
            if seconds <= *bound {
                self.counts[index].fetch_add(1, Ordering::Relaxed);
            }
        }
        self.sum_micros
            .fetch_add((seconds * 1_000_000.0).round() as u64, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> HistogramSnapshot {
        HistogramSnapshot {
            labels: String::new(),
            buckets: self
                .counts
                .iter()
                .map(|count| count.load(Ordering::Relaxed))
                .collect(),
            count: self.count.load(Ordering::Relaxed),
            sum_micros: self.sum_micros.load(Ordering::Relaxed),
        }
    }
}

/// Sampel berlabel untuk satu metrik: nama label literal + varian enum + nilai
/// atomik. Setiap varian SELALU menghasilkan satu sampel (termasuk yang bernilai
/// 0) — itu yang membuat dashboard menampilkan 0, bukan "No data", untuk label
/// yang belum pernah terjadi (mis. `result="failed"`).
fn labelled_samples<E: Copy>(
    label_name: &'static str,
    counters: &[AtomicU64],
    index_of: fn(E) -> usize,
    label_of: fn(E) -> &'static str,
    variants: &[E],
) -> Vec<(String, u64)> {
    variants
        .iter()
        .map(|variant| {
            let labels = format!("{{{label_name}=\"{}\"}}", label_of(*variant));
            (labels, counters[index_of(*variant)].load(Ordering::Relaxed))
        })
        .collect()
}

/// Deklarasi metrik `nyx_transport_*` (docs/30 WS-G(6)).
///
/// Nama sengaja `nyx_transport_*`, bukan `nyx_*` polos, supaya terlihat jelas di
/// dashboard bahwa angkanya datang dari **proses transport**, bukan dari API.
pub const METRIC_DEFS: &[MetricDef] = &[
    MetricDef {
        name: "nyx_transport_connections_total",
        kind: "counter",
        help: "Koneksi WebTransport masuk, per hasil handshake",
        samples: |m| {
            labelled_samples(
                "result",
                &m.connections,
                ConnectionOutcome::index,
                ConnectionOutcome::label,
                &ConnectionOutcome::ALL,
            )
        },
    },
    MetricDef {
        name: "nyx_transport_auth_total",
        kind: "counter",
        help: "Sesi yang berhasil terautentikasi, per metode",
        samples: |m| {
            labelled_samples(
                "method",
                &m.auth,
                AuthMethod::index,
                AuthMethod::label,
                &AuthMethod::ALL,
            )
        },
    },
    MetricDef {
        name: "nyx_transport_auth_failures_total",
        kind: "counter",
        help: "Percobaan autentikasi yang gagal, per alasan",
        samples: |m| {
            labelled_samples(
                "reason",
                &m.auth_failures,
                AuthFailure::index,
                AuthFailure::label,
                &AuthFailure::ALL,
            )
        },
    },
    MetricDef {
        name: "nyx_transport_session_kicks_total",
        kind: "counter",
        help: "Sesi lama yang diputus karena aturan satu-perangkat-aktif",
        samples: |m| vec![(String::new(), m.session_kicks.load(Ordering::Relaxed))],
    },
    MetricDef {
        name: "nyx_transport_rejected_frames_total",
        kind: "counter",
        help: "Frame masuk yang dibuang sebelum diteruskan, per alasan",
        samples: |m| {
            labelled_samples(
                "reason",
                &m.rejected_frames,
                RejectReason::index,
                RejectReason::label,
                &RejectReason::ALL,
            )
        },
    },
    MetricDef {
        name: "nyx_transport_relay_published_total",
        kind: "counter",
        help: "Frame yang BERHASIL diteruskan ke nyx:upstream Redis, per jalur masuk",
        samples: |m| {
            labelled_samples(
                "path",
                &m.relay_published,
                Path::index,
                Path::label,
                &Path::ALL,
            )
        },
    },
    MetricDef {
        name: "nyx_transport_downstream_total",
        kind: "counter",
        help: "Pesan nyx:downstream dari Redis, per hasil",
        samples: |m| {
            labelled_samples(
                "result",
                &m.downstream,
                DownstreamOutcome::index,
                DownstreamOutcome::label,
                &DownstreamOutcome::ALL,
            )
        },
    },
    MetricDef {
        name: "nyx_transport_bytes_total",
        kind: "counter",
        help: "Byte payload yang lewat sidecar, per arah",
        samples: |m| {
            labelled_samples(
                "direction",
                &m.bytes,
                Direction::index,
                Direction::label,
                &Direction::ALL,
            )
        },
    },
    MetricDef {
        name: "nyx_transport_active_sessions",
        kind: "gauge",
        help: "Sesi WebTransport aktif saat scrape",
        samples: |m| vec![(String::new(), m.active_sessions.load(Ordering::Relaxed))],
    },
    MetricDef {
        name: "nyx_transport_uptime_seconds",
        kind: "gauge",
        help: "Umur proses sidecar (detik); restart terlihat dari nilai yang turun",
        samples: |m| vec![(String::new(), m.started.elapsed().as_secs())],
    },
];

/// Deklarasi histogram sidecar.
///
/// Saat ini satu: latensi **ingress** jalur WebTransport. Ini satu-satunya hop
/// yang benar-benar dimiliki sidecar — dari frame klien utuh diterima sampai
/// Redis menerimanya (`nyx:upstream:<opcode>`). Pekerjaan Node (rate limit, DB,
/// fan-out) terjadi SETELAH hop ini dan diukur di jalur WSS sebagai
/// pembandingnya (docs/10 §10.12); perbedaan cakupan itu disengaja dan
/// dokumentasikan supaya kedua angka tidak dibaca sebagai hal yang sama.
pub const HISTOGRAM_DEFS: &[HistogramDef] = &[HistogramDef {
    name: "nyx_transport_ingress_seconds",
    help: "Latensi ingress WebTransport: dari frame klien utuh diterima sidecar sampai diteruskan ke Redis (nyx:upstream)",
    buckets: INGRESS_BUCKETS,
    samples: |m| vec![m.ingress.snapshot()],
}];

/// State metrik sidecar. Semua counter atomik: dipanggil dari banyak task tokio.
pub struct TransportMetrics {
    started: Instant,
    connections: [AtomicU64; 3],
    auth: [AtomicU64; 2],
    auth_failures: [AtomicU64; 4],
    rejected_frames: [AtomicU64; 4],
    relay_published: [AtomicU64; 3],
    downstream: [AtomicU64; 3],
    bytes: [AtomicU64; 2],
    session_kicks: AtomicU64,
    active_sessions: AtomicU64,
    ingress: Histogram,
}

impl Default for TransportMetrics {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportMetrics {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            connections: Default::default(),
            auth: Default::default(),
            auth_failures: Default::default(),
            rejected_frames: Default::default(),
            relay_published: Default::default(),
            downstream: Default::default(),
            bytes: Default::default(),
            session_kicks: AtomicU64::new(0),
            active_sessions: AtomicU64::new(0),
            ingress: Histogram::new(INGRESS_BUCKETS),
        }
    }

    pub fn connection(&self, outcome: ConnectionOutcome) {
        self.connections[outcome.index()].fetch_add(1, Ordering::Relaxed);
    }

    pub fn authenticated(&self, method: AuthMethod) {
        self.auth[method.index()].fetch_add(1, Ordering::Relaxed);
    }

    pub fn auth_failed(&self, reason: AuthFailure) {
        self.auth_failures[reason.index()].fetch_add(1, Ordering::Relaxed);
    }

    /// Frame dibuang sebelum diteruskan (CHAFF, terlalu besar, rusak, jalur salah).
    pub fn rejected(&self, reason: RejectReason) {
        self.rejected_frames[reason.index()].fetch_add(1, Ordering::Relaxed);
    }

    pub fn relay_published(&self, path: Path) {
        self.relay_published[path.index()].fetch_add(1, Ordering::Relaxed);
    }

    /// Latensi ingress satu frame: dari frame utuh diterima sampai Redis
    /// benar-benar menerimanya. Dipanggil HANYA saat publish berhasil — frame
    /// yang gagal diteruskan bukan "ingress lambat", melainkan kegagalan, dan
    /// itu sudah terlihat di `nyx_transport_relay_published_total`.
    pub fn ingress_seconds(&self, seconds: f64) {
        self.ingress.observe_seconds(seconds);
    }

    pub fn downstream(&self, outcome: DownstreamOutcome) {
        self.downstream[outcome.index()].fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_bytes(&self, direction: Direction, count: u64) {
        if count > 0 {
            self.bytes[direction.index()].fetch_add(count, Ordering::Relaxed);
        }
    }

    pub fn session_kicked(&self) {
        self.session_kicks.fetch_add(1, Ordering::Relaxed);
    }

    /// Gauge sesi di-set dari panjang map sesi (`DashMap::len`) saat scrape,
    /// bukan lewat increment/decrement: map itu juga dikurangi jalur "kick" dan
    /// penutupan koneksi bersamaan, dan dua jalur yang mengoreksi gauge sendiri
    /// adalah cara termudah menciptakan angka yang melenceng.
    pub fn set_active_sessions(&self, count: usize) {
        self.active_sessions.store(count as u64, Ordering::Relaxed);
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    /// Eksposisi teks format Prometheus 0.0.4 — dikelompokkan per metrik
    /// (HELP/TYPE lalu sampelnya), sesuai konvensi exporter lain di repo ini.
    pub fn render(&self) -> String {
        let mut out = String::with_capacity(2048);
        for def in METRIC_DEFS {
            out.push_str("# HELP ");
            out.push_str(def.name);
            out.push(' ');
            out.push_str(def.help);
            out.push_str("\n# TYPE ");
            out.push_str(def.name);
            out.push(' ');
            out.push_str(def.kind);
            out.push('\n');
            for (labels, value) in (def.samples)(self) {
                out.push_str(def.name);
                out.push_str(&labels);
                out.push(' ');
                out.push_str(&value.to_string());
                out.push('\n');
            }
        }
        for def in HISTOGRAM_DEFS {
            out.push_str("# HELP ");
            out.push_str(def.name);
            out.push(' ');
            out.push_str(def.help);
            out.push_str("\n# TYPE ");
            out.push_str(def.name);
            out.push_str(" histogram\n");
            for snapshot in (def.samples)(self) {
                for (index, bound) in def.buckets.iter().enumerate() {
                    out.push_str(def.name);
                    out.push_str("_bucket");
                    out.push_str(&bucket_labels(&snapshot.labels, &bound.to_string()));
                    out.push(' ');
                    out.push_str(&snapshot.buckets[index].to_string());
                    out.push('\n');
                }
                out.push_str(def.name);
                out.push_str("_bucket");
                out.push_str(&bucket_labels(&snapshot.labels, "+Inf"));
                out.push(' ');
                out.push_str(&snapshot.count.to_string());
                out.push('\n');
                out.push_str(def.name);
                out.push_str("_sum");
                out.push_str(&snapshot.labels);
                out.push(' ');
                out.push_str(&format!("{}", snapshot.sum_micros as f64 / 1_000_000.0));
                out.push('\n');
                out.push_str(def.name);
                out.push_str("_count");
                out.push_str(&snapshot.labels);
                out.push(' ');
                out.push_str(&snapshot.count.to_string());
                out.push('\n');
            }
        }
        out
    }
}

/// Gabungkan teks label dengan `le` untuk sampel `_bucket`.
///
/// `labels` selalu datang dari `HistogramSnapshot` (dibentuk di modul ini) dan
/// berbentuk `""` atau `{k="v",…}` — jadi `le` disisipkan sebelum kurung tutup.
/// Bucket histogram tanpa `le` akan ditolak Prometheus saat scrape, dan itu
/// berarti seluruh keluarga metrik itu hilang.
fn bucket_labels(labels: &str, bound: &str) -> String {
    if labels.is_empty() {
        format!("{{le=\"{bound}\"}}")
    } else {
        let prefix = labels.strip_suffix('}').unwrap_or(labels);
        format!("{prefix},le=\"{bound}\"}}")
    }
}

/// Host loopback saja (`127.0.0.0/8`, `::1`, `localhost`).
pub fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" || host == "::1" {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback(),
        _ => false,
    }
}

/// Validasi alamat exporter. Alamat non-loopback DITOLAK (bukan diperingatkan):
/// metrik transport memetakan infrastruktur (jumlah sesi, kegagalan auth), dan
/// `TRANSPORT_METRICS_ADDR=0.0.0.0:9465` yang salah tulis cukup untuk
/// membocorkannya ke jaringan — pola yang sama dengan `metricsEndpoint.ts`.
///
/// `Ok(None)` = exporter sengaja dimatikan (`""` atau `"0"`).
pub fn parse_metrics_addr(raw: &str) -> Result<Option<std::net::SocketAddr>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0" {
        return Ok(None);
    }
    let addr: std::net::SocketAddr = trimmed
        .parse()
        .map_err(|error| format!("TRANSPORT_METRICS_ADDR {trimmed:?} tidak sah: {error}"))?;
    if !addr.ip().is_loopback() {
        return Err(format!(
            "TRANSPORT_METRICS_ADDR harus loopback (127.0.0.1:9465), bukan {addr} — exporter tidak boleh terbuka ke jaringan"
        ));
    }
    Ok(Some(addr))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Setiap varian enum WAJIB menghasilkan satu sampel dengan nama label yang
    /// benar — termasuk yang bernilai 0. Kalau sebuah varian hilang dari `ALL`,
    /// alert yang bertumpu padanya (mis. `auth_failures{reason=…}`) tidak akan
    /// pernah menerima seri sama sekali.
    #[test]
    fn setiap_varian_enum_terekspos_dengan_nama_label_yang_benar() {
        let text = TransportMetrics::new().render();
        let expectations: [(&str, &str, &[&str]); 7] = [
            (
                "nyx_transport_connections_total",
                "result",
                &["accepted", "rejected", "failed"],
            ),
            ("nyx_transport_auth_total", "method", &["ticket", "bwh"]),
            (
                "nyx_transport_auth_failures_total",
                "reason",
                &[
                    "ticket_invalid",
                    "token_too_large",
                    "bwh_invalid",
                    "no_identifier",
                ],
            ),
            (
                "nyx_transport_rejected_frames_total",
                "reason",
                &["chaff", "too_large", "malformed", "hello_wrong_path"],
            ),
            (
                "nyx_transport_relay_published_total",
                "path",
                &["bidi", "uni", "datagram"],
            ),
            (
                "nyx_transport_downstream_total",
                "result",
                &["delivered", "no_session", "dropped"],
            ),
            ("nyx_transport_bytes_total", "direction", &["in", "out"]),
        ];

        for (name, label_name, values) in expectations {
            for value in values {
                let expected = format!("{name}{{{label_name}=\"{value}\"}} 0");
                assert!(text.contains(&expected), "hilang: {expected}\n{text}");
            }
        }
    }

    #[test]
    fn setiap_metrik_terdeklarasi_dan_terekspos() {
        let metrics = TransportMetrics::new();
        let text = metrics.render();

        for def in METRIC_DEFS {
            assert!(
                text.contains(&format!("# TYPE {} {}\n", def.name, def.kind)),
                "metrik {} tidak terekspos",
                def.name
            );
            assert!(
                text.contains(&format!("# HELP {} ", def.name)),
                "metrik {} tidak punya HELP",
                def.name
            );
            assert!(def.name.starts_with("nyx_transport_"), "{}", def.name);
            assert!(
                def.name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "nama metrik harus snake_case ASCII: {}",
                def.name
            );
            assert!(!def.help.is_empty(), "{} tanpa help", def.name);
        }

        for def in HISTOGRAM_DEFS {
            assert!(
                text.contains(&format!("# TYPE {} histogram\n", def.name)),
                "histogram {} tidak terekspos",
                def.name
            );
            assert!(
                text.contains(&format!("# HELP {} ", def.name)),
                "histogram {} tidak punya HELP",
                def.name
            );
            assert!(def.name.starts_with("nyx_transport_"), "{}", def.name);
            assert!(!def.help.is_empty(), "{} tanpa help", def.name);
            assert!(!def.buckets.is_empty(), "{} tanpa bucket", def.name);
            // Bucket WAJIB naik monoton: histogram_quantile atas bucket yang
            // tidak berurutan menghasilkan angka yang tidak berarti, dan
            // Prometheus tidak memberi peringatan apa pun soal itu.
            assert!(
                def.buckets.windows(2).all(|pair| pair[0] < pair[1]),
                "bucket {} tidak naik monoton",
                def.name
            );
        }

        // Jumlah TYPE = jumlah deklarasi: tidak ada metrik yang lahir dari runtime.
        let type_lines = text
            .lines()
            .filter(|line| line.starts_with("# TYPE "))
            .count();
        assert_eq!(type_lines, METRIC_DEFS.len() + HISTOGRAM_DEFS.len());
    }

    /// Histogram yang belum pernah menerima observasi HARUS tetap tampil sebagai
    /// deret bernilai 0 (bukan hilang): dashboard lalu menampilkan 0 alih-alih
    /// "No data", dan `rate(..._count[5m]) > 0` bisa dipakai sebagai penjaga
    /// "ada trafik" tanpa bergantung pada keberadaan seri.
    #[test]
    fn histogram_tanpa_observasi_tetap_terekspos_bernilai_nol() {
        let text = TransportMetrics::new().render();
        for def in HISTOGRAM_DEFS {
            for bound in def.buckets {
                assert!(
                    text.contains(&format!("{}_bucket{{le=\"{}\"}} 0", def.name, bound)),
                    "bucket {} le={} hilang",
                    def.name,
                    bound
                );
            }
            assert!(text.contains(&format!("{}_bucket{{le=\"+Inf\"}} 0", def.name)));
            assert!(text.contains(&format!("{}_sum 0\n", def.name)));
            assert!(text.contains(&format!("{}_count 0\n", def.name)));
        }
    }

    /// Semantik bucket kumulatif + `+Inf` + `_sum` dalam detik. Salah di sini
    /// tidak terlihat di unit test mana pun yang lain: `histogram_quantile` akan
    /// tetap mengembalikan angka, hanya saja angkanya bohong.
    #[test]
    fn observasi_mengisi_bucket_kumulatif_dan_sum_detik() {
        let metrics = TransportMetrics::new();
        let buckets = HISTOGRAM_DEFS[0].buckets;

        // 0,5 ms (<= 0.001, hanya bucket pertama) dan 40 ms (<= 0.05 ke atas).
        metrics.ingress_seconds(0.0005);
        metrics.ingress_seconds(0.04);
        // Nilai tak sah: harus diabaikan, bukan dijepit.
        metrics.ingress_seconds(f64::NAN);
        metrics.ingress_seconds(-1.0);

        let text = metrics.render();
        let name = HISTOGRAM_DEFS[0].name;
        for bound in buckets {
            let expected = if *bound < 0.0005 {
                0
            } else if *bound < 0.04 {
                1
            } else {
                2
            };
            assert!(
                text.contains(&format!("{name}_bucket{{le=\"{bound}\"}} {expected}")),
                "bucket {bound} seharusnya {expected}\n{text}"
            );
        }
        assert!(text.contains(&format!("{name}_bucket{{le=\"+Inf\"}} 2")));
        assert!(text.contains(&format!("{name}_count 2")));
        // 0,0005 + 0,04 = 0,0405 detik.
        assert!(text.contains(&format!("{name}_sum 0.0405")), "{text}");
    }

    #[test]
    fn hitungan_terlihat_di_render() {
        let metrics = TransportMetrics::new();
        metrics.connection(ConnectionOutcome::Accepted);
        metrics.connection(ConnectionOutcome::Failed);
        metrics.connection(ConnectionOutcome::Failed);
        metrics.authenticated(AuthMethod::Ticket);
        metrics.auth_failed(AuthFailure::TicketInvalid);
        metrics.rejected(RejectReason::Chaff);
        metrics.relay_published(Path::Uni);
        metrics.downstream(DownstreamOutcome::Delivered);
        metrics.add_bytes(Direction::In, 512);
        metrics.session_kicked();
        metrics.set_active_sessions(3);

        let text = metrics.render();
        for expected in [
            "nyx_transport_connections_total{result=\"accepted\"} 1",
            "nyx_transport_connections_total{result=\"failed\"} 2",
            "nyx_transport_connections_total{result=\"rejected\"} 0",
            "nyx_transport_auth_total{method=\"ticket\"} 1",
            "nyx_transport_auth_failures_total{reason=\"ticket_invalid\"} 1",
            "nyx_transport_rejected_frames_total{reason=\"chaff\"} 1",
            "nyx_transport_relay_published_total{path=\"uni\"} 1",
            "nyx_transport_downstream_total{result=\"delivered\"} 1",
            "nyx_transport_bytes_total{direction=\"in\"} 512",
            "nyx_transport_session_kicks_total 1",
            "nyx_transport_active_sessions 3",
        ] {
            assert!(text.contains(expected), "hilang: {expected}\n{text}");
        }
        assert!(text.contains("nyx_transport_uptime_seconds "));
        // Nilai negatif tidak mungkin (counter u64), jadi cukup pastikan angka.
        assert!(metrics.uptime_seconds() < 60);
    }

    #[test]
    fn alamat_non_loopback_ditolak() {
        assert_eq!(parse_metrics_addr("").unwrap(), None);
        assert_eq!(parse_metrics_addr("0").unwrap(), None);
        assert_eq!(parse_metrics_addr("  0  ").unwrap(), None);
        assert!(parse_metrics_addr("127.0.0.1:9465").unwrap().is_some());
        assert!(parse_metrics_addr("[::1]:9465").unwrap().is_some());
        // Kesalahan yang paling mudah terjadi — dan yang paling mahal.
        assert!(parse_metrics_addr("0.0.0.0:9465").is_err());
        assert!(parse_metrics_addr("192.168.1.10:9465").is_err());
        assert!(parse_metrics_addr("bukan-alamat").is_err());
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.8.8.8"));
        assert!(is_loopback_host("localhost"));
        assert!(!is_loopback_host("10.0.0.1"));
    }
}
