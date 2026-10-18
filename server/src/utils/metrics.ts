// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

/**
 * [docs/27 §27.7 + docs/30 WS-G] Metrik operasional TANPA telemetry.
 *
 * Prinsip (docs/30 §30.1 poin 4): metrik hanya boleh berupa **hitungan event**,
 * tidak pernah identitas. Modul ini menegakkannya secara struktural, bukan lewat
 * disiplin penulis kode:
 *
 *   1. Metrik WAJIB dideklarasikan lebih dulu (`defineCounter`/`defineGauge`/
 *      `defineHistogram`) — jadi tidak ada deret waktu yang lahir dari nilai
 *      runtime (kardinalitas tak terbatas = bentuk exfil paling mudah).
 *   2. Nama label WAJIB ada di deklarasi metrik.
 *   3. Nilai label WAJIB lolos `isSafeLabelValue()`: pendek, dan tidak berbentuk
 *      UUID / heksadesimal panjang / base64url panjang / IP / email.
 *      Pelanggaran ditolak + dihitung di `nyx_metrics_rejected_total`
 *      (jadi percobaan menaruh identitas ke metrik justru TERLIHAT, bukan hilang).
 *
 * Tidak ada dependency: eksposisi teks format Prometheus ditulis di sini supaya
 * jalur ini bisa diuji tanpa jaringan dan tanpa supply chain baru.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDef {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly labelNames: readonly string[];
  /** Batas bucket histogram (detik / satuan apa pun yang diukur). */
  readonly buckets?: readonly number[];
}

interface Series {
  labels: Record<string, string>;
  value: number;
  /** Khusus histogram. */
  bucketCounts?: number[];
  sum?: number;
  count?: number;
}

interface MetricState {
  def: MetricDef;
  series: Map<string, Series>;
}

/** Panjang maksimum nilai label — enum pendek, bukan identifier. */
const MAX_LABEL_VALUE_LENGTH = 24;

/**
 * Bentuk yang DILARANG muncul sebagai nilai label. Semuanya adalah nilai yang
 * bisa memetakan metrik kembali ke user/perangkat.
 */
const FORBIDDEN_LABEL_VALUE_PATTERNS: readonly RegExp[] = [
  // UUID (userId, conversationId, deviceId).
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // Heksadesimal panjang: 32 byte (usernameHash/identityKey) ke atas.
  /^[0-9a-f]{32,}$/i,
  // base64url panjang: hashId / token / key.
  /^[A-Za-z0-9_-]{22,}$/,
  // IPv4.
  /^\d{1,3}(\.\d{1,3}){3}$/,
  // IPv6 (setidaknya dua blok titik-dua).
  /(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}/i,
  // Email.
  /@/,
];

const METRIC_NAME_PATTERN = /^nyx_[a-z0-9_]+$/;

const metrics = new Map<string, MetricState>();

/** Alasan penolakan — nilainya enum pendek (aman untuk label). */
type RejectionReason = 'unknown_metric' | 'unknown_label' | 'label_value' | 'wrong_type';

function defineMetric(def: MetricDef): MetricDef {
  if (!METRIC_NAME_PATTERN.test(def.name)) {
    throw new Error(`Nama metrik tidak sah (harus nyx_<snake_case>): ${def.name}`);
  }
  if (metrics.has(def.name)) {
    throw new Error(`Metrik sudah dideklarasikan: ${def.name}`);
  }
  for (const label of def.labelNames) {
    if (!/^[a-z][a-z0-9_]*$/.test(label)) {
      throw new Error(`Nama label tidak sah pada ${def.name}: ${label}`);
    }
  }
  if (def.type === 'histogram' && (!def.buckets || def.buckets.length === 0)) {
    throw new Error(`Histogram ${def.name} harus punya buckets`);
  }
  metrics.set(def.name, { def, series: new Map() });
  return def;
}

export function defineCounter(
  name: string,
  help: string,
  labelNames: readonly string[] = []
): MetricDef {
  return defineMetric({ name, type: 'counter', help, labelNames });
}

export function defineGauge(
  name: string,
  help: string,
  labelNames: readonly string[] = []
): MetricDef {
  return defineMetric({ name, type: 'gauge', help, labelNames });
}

export function defineHistogram(
  name: string,
  help: string,
  buckets: readonly number[],
  labelNames: readonly string[] = []
): MetricDef {
  return defineMetric({ name, type: 'histogram', help, labelNames, buckets });
}

function isSafeLabelValue(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_LABEL_VALUE_LENGTH) return false;
  return !FORBIDDEN_LABEL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function seriesKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${labels[key]}`).join('|');
}

function getOrCreateSeries(state: MetricState, normalized: Record<string, string>): Series {
  const key = seriesKey(normalized);
  let series = state.series.get(key);
  if (!series) {
    series = { labels: normalized, value: 0 };
    if (state.def.type === 'histogram') {
      series.bucketCounts = Array.from({ length: state.def.buckets!.length }, () => 0);
      series.sum = 0;
      series.count = 0;
    }
    state.series.set(key, series);
  }
  return series;
}

/** Validasi nama label + nilai; `null` = tolak (dan hitung sebagai penolakan). */
function validateLabels(
  def: MetricDef,
  labels: Record<string, string | number> | undefined
): Record<string, string> | null {
  const normalized: Record<string, string> = {};
  if (!labels) return normalized;

  for (const [name, raw] of Object.entries(labels)) {
    if (!def.labelNames.includes(name)) {
      return null;
    }
    if (!isSafeLabelValue(raw)) {
      return null;
    }
    normalized[name] = String(raw);
  }
  // Semua label terdeklarasi WAJIB ada, supaya deret waktu tidak bercampur
  // bentuk (satu metrik dengan 2 himpunan label berbeda = query yang bohong).
  for (const required of def.labelNames) {
    if (!(required in normalized)) return null;
  }
  return normalized;
}

function recordRejection(reason: RejectionReason): void {
  const state = metrics.get('nyx_metrics_rejected_total');
  if (!state) return;
  const series = getOrCreateSeries(state, { reason });
  series.value += 1;
}

/** Tambah counter. Kalau label identitas → ditolak + tercatat, bukan dikirim. */
export function incCounter(def: MetricDef, labels?: Record<string, string | number>, amount = 1): void {
  const state = metrics.get(def.name);
  if (!state) {
    recordRejection('unknown_metric');
    return;
  }
  const normalized = validateLabels(state.def, labels);
  if (!normalized) {
    recordRejection('label_value');
    return;
  }
  if (state.def.type !== 'counter') {
    recordRejection('wrong_type');
    return;
  }
  getOrCreateSeries(state, normalized).value += amount;
}

export function setGauge(def: MetricDef, value: number, labels?: Record<string, string | number>): void {
  const state = metrics.get(def.name);
  if (!state) {
    recordRejection('unknown_metric');
    return;
  }
  if (state.def.type !== 'gauge') {
    recordRejection('wrong_type');
    return;
  }
  const normalized = validateLabels(state.def, labels);
  if (!normalized) {
    recordRejection('label_value');
    return;
  }
  getOrCreateSeries(state, normalized).value = value;
}

export function observeHistogram(def: MetricDef, value: number, labels?: Record<string, string | number>): void {
  const state = metrics.get(def.name);
  if (!state) {
    recordRejection('unknown_metric');
    return;
  }
  if (state.def.type !== 'histogram' || !state.def.buckets) {
    recordRejection('wrong_type');
    return;
  }
  if (!Number.isFinite(value)) {
    recordRejection('label_value');
    return;
  }
  const normalized = validateLabels(state.def, labels);
  if (!normalized) {
    recordRejection('label_value');
    return;
  }
  const series = getOrCreateSeries(state, normalized);
  const buckets = state.def.buckets;
  for (let i = 0; i < buckets.length; i++) {
    if (value <= buckets[i]!) series.bucketCounts![i]! += 1;
  }
  series.sum! += value;
  series.count! += 1;
}

/** Timestamp waktu-proses (untuk `*_last_run_timestamp_seconds`). */
export function nowSeconds(): number {
  return Date.now() / 1000;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatSample(name: string, labels: Record<string, string>, value: number): string {
  const keys = Object.keys(labels).sort();
  const labelText =
    keys.length === 0
      ? ''
      : `{${keys.map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`).join(',')}}`;
  // Prometheus menolak NaN/Inf pada counter; gauge boleh (mis. suhu tak tersedia).
  const numeric = Number.isFinite(value) ? value : 0;
  return `${name}${labelText} ${numeric}`;
}

/** Eksposisi format teks Prometheus 0.0.4. */
export function renderMetricsText(): string {
  const lines: string[] = [];
  for (const state of metrics.values()) {
    const { def } = state;
    lines.push(`# HELP ${def.name} ${def.help.replace(/\n/g, ' ')}`);
    lines.push(`# TYPE ${def.name} ${def.type}`);
    if (def.type === 'histogram') {
      const buckets = def.buckets!;
      // Histogram TANPA label dan TANPA observasi tetap dirender sebagai deret
      // bernilai 0 ("nol pengamatan"), bukan hilang. Aturannya sama dengan
      // exporter sidecar Rust (`HISTOGRAM_DEFS` di metrics.rs): dashboard lalu
      // menampilkan 0 alih-alih "No data", dan `rate(..._count[5m]) > 0` bisa
      // dipakai sebagai penjaga "ada trafik" tanpa bergantung pada keberadaan
      // seri. Untuk histogram BERLABEL ini tidak mungkin dilakukan (nilai label
      // tidak diketahui sebelum observasi pertama), jadi jalur itu dibiarkan
      // tetap "No data" sampai ada sampel — dan itu memang artinya.
      if (state.series.size === 0 && def.labelNames.length === 0) {
        for (const bound of buckets) {
          lines.push(formatSample(`${def.name}_bucket`, { le: String(bound) }, 0));
        }
        lines.push(formatSample(`${def.name}_bucket`, { le: '+Inf' }, 0));
        lines.push(formatSample(`${def.name}_sum`, {}, 0));
        lines.push(formatSample(`${def.name}_count`, {}, 0));
        continue;
      }
      for (const series of state.series.values()) {
        for (let i = 0; i < buckets.length; i++) {
          lines.push(
            formatSample(`${def.name}_bucket`, { ...series.labels, le: String(buckets[i]) }, series.bucketCounts![i]!)
          );
        }
        lines.push(formatSample(`${def.name}_bucket`, { ...series.labels, le: '+Inf' }, series.count!));
        lines.push(formatSample(`${def.name}_sum`, series.labels, series.sum!));
        lines.push(formatSample(`${def.name}_count`, series.labels, series.count!));
      }
      continue;
    }
    for (const series of state.series.values()) {
      lines.push(formatSample(def.name, series.labels, series.value));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Reset seluruh deret waktu (hook test saja) — deklarasi metrik tetap. */
export function resetMetricsForTests(): void {
  for (const state of metrics.values()) {
    state.series.clear();
  }
}

// ============================================================================
// Deklarasi metrik NYX (docs/30 WS-G). Semua nama label = enum pendek.
// ============================================================================

/** Penolakan pencatatan metrik karena label tidak sah (harus tetap 0). */
export const METRICS_REJECTED = defineCounter(
  'nyx_metrics_rejected_total',
  'Percobaan mencatat metrik dengan label tidak sah (indikasi kebocoran identitas ke metrik)',
  ['reason']
);

/** Operasi relay yang diproses, per opcode transport. */
export const RELAY_OPS = defineCounter(
  'nyx_relay_ops_total',
  'Operasi relay upstream yang diproses, per opcode',
  ['op', 'result']
);

/** Sesi/perangkat yang ditolak pemeriksaan keamanan (single-active-device, hardware mismatch). */
export const SECURITY_BLOCKS = defineCounter(
  'nyx_security_blocks_total',
  'Operasi yang diblokir pemeriksaan keamanan sesi/perangkat',
  ['op', 'reason']
);

/**
 * [docs/10 §10.12] Latensi ingress jalur **WSS** (fallback): dari event
 * socket.io diterima gateway sampai handler-nya selesai (validasi + rate limit +
 * pemeriksaan perangkat + publish ke `nyx:downstream`).
 *
 * Kenapa ini ada: jalur WebTransport punya angkanya sendiri
 * (`nyx_transport_ingress_seconds`, diukur di sidecar). Tanpa pembanding di sisi
 * WSS, "jalur cepat lambat" hanya bisa dibandingkan dengan ambang mutlak yang
 * berbeda-beda per host. Dengan dua angka ini, pertanyaannya jadi faktual:
 * **apakah jalur cepat masih lebih cepat daripada jalur cadangannya?**
 *
 * Cakupannya sengaja TIDAK identik dengan sisi WebTransport — span WSS memuat
 * pekerjaan yang di jalur WT terjadi setelah hop sidecar (Node tetap memproses
 * `nyx:upstream:<op>` dengan handler yang sama). Karena itu aturan alertnya hanya
 * menyala ketika jalur cepat benar-benar lebih lambat daripada jalur cadangan
 * yang pekerjaannya LEBIH BANYAK — arah yang salah untuk alarm palsu.
 *
 * Bucket-nya WAJIB sama dengan `INGRESS_BUCKETS` di
 * `server/transport-sidecar/src/metrics.rs`: dua histogram dengan pembagian
 * bucket berbeda menghasilkan p95 yang tidak sebanding, dan itu membuat seluruh
 * perbandingannya bohong tanpa satu pun error.
 */
export const WSS_INGRESS_SECONDS = defineHistogram(
  'nyx_wss_ingress_seconds',
  'Latensi ingress jalur WSS: dari event socket.io diterima sampai handler selesai (validasi + rate limit + publish)',
  [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
);

/** Durasi satu putaran sweeper (detik). */
export const SWEEPER_DURATION = defineHistogram(
  'nyx_sweeper_duration_seconds',
  'Durasi putaran sweeper sistem',
  [1, 5, 15, 30, 60, 120, 300],
  ['result']
);

/** Waktu (unix) putaran sweeper terakhir yang selesai. */
export const SWEEPER_LAST_RUN = defineGauge(
  'nyx_sweeper_last_run_timestamp_seconds',
  'Unix timestamp putaran sweeper terakhir yang selesai',
  ['result']
);

/** [docs/31 §31.6 fase 3] Operasi backup (presign/unduh/hapus), per hasil. Tanpa identitas. */
export const BACKUP_OPS = defineCounter(
  'nyx_backup_ops_total',
  'Operasi endpoint backup, per op dan hasil',
  ['op', 'result']
);

/** [docs/30 §30.5 WS-A] Penulisan entri log Key Transparency, per hasil. Tanpa identitas. */
export const KT_WRITES = defineCounter(
  'nyx_kt_writes_total',
  'Penulisan entri log Key Transparency, per hasil',
  ['result']
);

/** Unix timestamp penulisan log KT terakhir yang berhasil (lag = now − nilai ini). */
export const KT_LAST_SUCCESS = defineGauge(
  'nyx_kt_last_success_timestamp_seconds',
  'Unix timestamp penulisan log Key Transparency terakhir yang berhasil'
);

/**
 * [docs/30 §30.5 WS-A / docs/32 §32.8] Permintaan bukti ke layanan baca KT
 * (proxy `/api/keys/kt/*`), per hasil. `disabled` penting: tanpa `KT_QUERY_URL`
 * klien jatuh ke TOFU, dan itu harus terlihat di dashboard, bukan senyap.
 */
export const KT_QUERIES = defineCounter(
  'nyx_kt_queries_total',
  'Permintaan bukti Key Transparency (baca), per hasil',
  ['result']
);

/**
 * [docs/10 §10.13] Unggahan arsip snapshot log KT ke R2, per hasil. `error`
 * penting: snapshot yang tiap hari gagal diunggah berarti log hanya hidup di
 * satu disk, dan itu tidak terlihat dari mana pun kecuali dari sini.
 */
export const KT_SNAPSHOT_UPLOAD = defineCounter(
  'nyx_kt_snapshot_upload_total',
  'Unggahan arsip snapshot log Key Transparency ke R2, per hasil',
  ['result']
);

/** Arsip snapshot log KT yang dihapus dari R2 karena melewati retensi. */
export const KT_SNAPSHOT_DELETED = defineCounter(
  'nyx_kt_snapshot_deleted_total',
  'Arsip snapshot log Key Transparency yang dihapus dari R2, per hasil',
  ['result']
);

/**
 * [drill 2026-10-16 · docs/10 §10.13] Unix timestamp arsip snapshot log KT
 * terbaru yang **benar-benar ada di R2** (umur = now − nilai ini).
 *
 * Kenapa ukurannya umur arsip di R2, bukan jumlah unggahan: counter
 * `nyx_kt_snapshot_upload_total` hanya naik saat ada arsip BARU, sehingga dua
 * keadaan yang sehat menghasilkan seri datar — jalur idempoten
 * (`skipped: already-uploaded`) dan restart proses NYX (label-child prom-client
 * lahir kembali hanya pada `.inc()` pertama). Alert berbasis `increase(counter)
 * == 0` karena itu menyala palsu setelah restart; nilainya di sini diturunkan
 * dari daftar objek R2, jadi restart tidak mengubah kebenarannya dan jalur
 * idempoten tetap memutakhirkan metrik ini.
 */
export const KT_SNAPSHOT_REMOTE_LATEST = defineGauge(
  'nyx_kt_snapshot_remote_latest_timestamp_seconds',
  'Unix timestamp arsip snapshot log Key Transparency terbaru yang ada di R2'
);

/**
 * [docs/30 §30.12 WS-H] Hasil evaluasi guard registrasi, per tindakan + alasan.
 *
 * `would_*` adalah **mode shadow** (`ABUSE_REGISTRATION_GUARD=shadow`): guard
 * mengevaluasi persis seperti mode `on` tetapi tidak menahan siapa pun — hanya
 * mencatat berapa banyak yang *akan* tertahan/wajib attestation. Inilah cara
 * mengukur false-positive NAT besar (kantor dengan satu ASN) dengan data
 * lapangan tanpa memblokir satu pun pengguna sah; tanpa mode ini, satu-satunya
 * cara mengukur adalah menyalakan blokir dan melihat keluhan.
 */
export const REGISTRATION_GUARD_OBSERVED = defineCounter(
  'nyx_registration_guard_observed_total',
  'Hasil evaluasi guard registrasi (shadow = keputusan hipotetis), per tindakan dan alasan',
  ['action', 'reason']
);

/** Baris yang dibersihkan sweeper, per jenis. */
export const SWEEPER_DELETED = defineCounter(
  'nyx_sweeper_deleted_rows_total',
  'Baris yang dihapus sweeper sistem, per jenis',
  ['kind']
);

/**
 * [R6 2026-10-15] Pemanggilan pemeliharaan manual `POST /api/admin/cleanup`,
 * per hasil. Endpoint ini **destruktif** (menghancurkan akun dorman), jadi
 * pemanggilannya — termasuk yang DITOLAK — harus terlihat di dashboard tanpa
 * membaca log. Labelnya hanya enum (`ok`/`partial`/`error`/`forbidden`/
 * `rate_limited`), tanpa IP atau rahasia.
 */
export const ADMIN_CLEANUP = defineCounter(
  'nyx_admin_cleanup_total',
  'Pemanggilan pemeliharaan manual /api/admin/cleanup, per hasil',
  ['result']
);

/**
 * [R11 2026-10-15] Apakah guard anti-abuse menyala **saat proses ini boot**.
 *
 * Kenapa perlu metrik, bukan cuma log: `ABUSE_REGISTRATION_GUARD` dan
 * `ABUSE_REQUIRE_ATTESTATION` default-nya `off`, jadi deployment produksi yang
 * lupa menyalakannya tampak sehat sepenuhnya (tidak ada error, tidak ada
 * penolakan) — hanya tidak ada perlindungan. Gauge ini membuat keadaan itu bisa
 * di-alert (`ops/prometheus/alerts.yml`) alih-alih bergantung pada ingatan
 * operator. Nilai 1 = menyala, 0 = off.
 */
export const ABUSE_GUARD_ENABLED = defineGauge(
  'nyx_abuse_guard_enabled',
  'Guard anti-abuse registrasi menyala (1) atau off (0), per guard',
  ['guard']
);

/**
 * [docs/30 §30.12 WS-H] Hasil gerbang attestation perangkat saat pendaftaran
 * akun baru, per hasil + alasan.
 *
 * Kenapa butuh metrik, bukan cuma log `403`: penolakan attestation tampak
 * seperti pengguna yang salah mengisi form. Tidak ada error server, tidak ada
 * penolakan di endpoint lain, dan satu-satunya jejak adalah satu baris log per
 * percobaan. Dua keadaan paling mahal justru berbentuk begitu:
 *
 *   1. `result="rejected", reason="root_not_trusted"` — bundle root operator
 *      ketinggalan model perangkat baru, sehingga **akun baru tidak bisa
 *      dibuat** oleh pemilik perangkat itu, bukan hanya oleh sybil;
 *   2. laju penolakan tinggi secara umum (`result="rejected"` dibanding
 *      `result="accepted"`) — kebijakan tidak cocok dengan perangkat di
 *      lapangan, dan itu harus terlihat sebelum jadi keluhan.
 *
 * Label `reason` hanya memuat kode enum pendek dari `attestationReasonCode()`:
 * kode asli pemeriksa rantai lebih panjang dari batas label dan sebagian memuat
 * nama OID/penerbit. Alasan yang belum dipetakan masuk sebagai `unmapped` —
 * jadi penambahan kode baru justru terlihat, bukan hilang.
 */
export const ATTESTATION_REGISTRATION = defineCounter(
  'nyx_attestation_registration_total',
  'Hasil verifikasi attestation perangkat pada pendaftaran akun baru, per hasil dan alasan',
  ['result', 'reason']
);

/**
 * [docs/30 §30.12 WS-H] Keadaan bundle root attestation, diisi saat boot dari
 * berkas + metadata yang ditulis `scripts/attestation-roots.mjs refresh`.
 *
 * Kenapa gauge, bukan cuma peringatan log: peringatan boot hanya terlihat oleh
 * orang yang membaca log tepat setelah restart — padahal bundle basi justru
 * masalah BERJALAN LAMA (MDS `nextUpdate` lewat 3 minggu, root vendor
 * kedaluwarsa), dan tidak menghasilkan error apa pun sampai perangkat baru
 * ditolak. Dua gauge ini membuat hal itu bisa di-alert (`NyxAttestationRoot*`).
 *
 * Tanpa `ABUSE_ATTESTATION_ROOTS_FILE`, gauge TIDAK di-set: aturan alert jadi
 * diam, bukan menyala palsu untuk deployment yang tidak memakai attestation.
 */
export const ATTESTATION_ROOTS_EXPIRED_CERTS = defineGauge(
  'nyx_attestation_roots_expired_certs',
  'Jumlah sertifikat root attestation di bundle yang sudah lewat validTo'
);

export const ATTESTATION_ROOTS_NEXT_UPDATE = defineGauge(
  'nyx_attestation_roots_next_update_timestamp_seconds',
  'Tanggal nextUpdate FIDO MDS dari metadata bundle root attestation (detik epoch)'
);

/**
 * [docs/29 §5.6 · docs/33 §33.7] Kapabilitas hasil negosiasi jalur **WSS**,
 * per kapabilitas (`capability="none"` = klien mengiklankan sesuatu yang tidak
 * dikenal gateway).
 *
 * Kenapa perlu: `spqr-ratchet` (ratchet v2, braid SPQR) hanya dipakai kalau
 * relay yang aktif mengiklankannya. Sebelum ini, jalur WSS tidak pernah bisa
 * mengiklankannya, jadi satu-satunya cara tahu "berapa klien yang bisa v2"
 * adalah menebak. Seri datar di sini berarti tidak ada klien yang mengiklankan
 * apa pun (mis. semua masih klien lama) — bukan "semua sudah v2".
 *
 * Labelnya hanya enum dari `SERVER_CAPABILITIES` (nama kapabilitas pendek,
 * tanpa versi klien/ID perangkat).
 */
export const WSS_CAPABILITY = defineCounter(
  'nyx_wss_capability_total',
  'Kapabilitas transport hasil negosiasi jalur WSS, per kapabilitas',
  ['capability']
);

/**
 * [R2 2026-10-15] Permintaan API yang ditolak karena versi klien di bawah
 * `MIN_CLIENT_VERSION` (HTTP 426), per alasan.
 *
 * Kenapa perlu: klien lama yang tertinggal di cache service worker/PWA adalah
alasan utama penolakan ini terjadi massal — dan tanpa metrik, satu-satunya
jejaknya adalah keluhan pengguna. Labelnya enum (`too-old`), tanpa identitas.
 * Gerbangnya sendiri mati bila `MIN_CLIENT_VERSION` tidak diset, jadi seri
 * datar di sini berarti "tidak ada yang ditolak", bukan "tidak ada yang tua".
 */
export const CLIENT_VERSION_REJECTED = defineCounter(
  'nyx_client_version_rejected_total',
  'Permintaan API yang ditolak karena versi klien di bawah minimum, per alasan',
  ['result']
);
