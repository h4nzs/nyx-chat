# testdata — vektor auditor (fixture, bukan kode NYX)

`katie_test_vectors.pb` disalin **apa adanya** dari implementasi auditor referensi
Signal:

- repo: `github.com/signalapp/keytransparency-auditor`
- berkas: `src/test/resources/org/signal/keytransparency/audit/katie_test_vectors.pb`
- SHA-256: `c97e0e93eaf0b8c6377da1108b96b886a85e31bf97a8c8917ba3f2ca334d6ecb`
- lisensi: AGPL-3.0 (`LICENSE.key-transparency-auditor` di direktori ini)

Isinya adalah pesan protobuf `TestVectors` (proto: `src/test/proto/test_vector.proto`,
dependensi `kt.AuditorUpdate` dari `key-transparency-server`) yang dihasilkan
`cmd/generate-auditing-test-vectors` di repo `key-transparency-server`:

- `should_fail` — lima rangkaian update yang **harus** ditolak auditor
  (`newTree` bukan proof pertama, `newTree` untuk pohon tidak kosong,
  `differentKey`/`sameKey` tidak cocok dengan root lama, `sameKey` untuk update palsu);
- `should_succeed` — sepuluh update berurutan + root hash pohon log yang diharapkan
  **setelah tiap update**;
- `signature` — kunci auditor (PKCS#8), mode deployment, kunci publik layanan
  (tanda tangan + VRF), ukuran pohon, timestamp, root, `signature_input`, dan tanda tangan.

`vectors_test.go` memverifikasi port Go di direktori induk terhadap berkas ini:
port diterima pada `should_succeed` (termasuk root hash tiap langkah), ditolak pada
kelima `should_fail`, dan tanda tangan tree head-nya cocok byte-per-byte.

Berkas ini **tidak** dipakai saat runtime; ia hanya fixture uji.
