// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
//
// [docs/30 WS-G(6)] ORACLE independen untuk primitif ratchet NYX.
//
// Masalah yang ditutup berkas ini: semua test kripto NYX yang ada memanggil
// implementasi NYX dengan implementasi NYX (libsodium yang sama) — jadi
// kesalahan sistematis (urutan DH, panjang KEM, mode BLAKE2b, format ciphertext
// X-Wing) tidak bisa terdeteksi: dua salinan kode yang sama-sama salah akan
// sama-sama setuju.
//
// Oracle di sini **tidak memakai libsodium sama sekali**. Setiap primitif
// dihitung oleh pustaka lain:
//
//	X25519             golang.org/x/crypto/curve25519
//	Ed25519            crypto/ed25519 (stdlib) + konversi Edwards→Montgomery
//	                   ditulis sendiri (math/big), BUKAN crypto_sign_*_to_curve25519
//	X-Wing             github.com/cloudflare/circl/kem/xwing
//	                   (ML-KEM-768 + X25519, draft-connolly-cfrg-xwing-kem-05)
//	BLAKE2b (keyed)    golang.org/x/crypto/blake2b
//	XChaCha20-Poly1305 golang.org/x/crypto/chacha20poly1305 (NewX)
//
// Arah uji:
//   - oracle → NYX: vektor di `web/src/lib/__tests__/fixtures/x3dhOracleVectors.json`,
//     diverifikasi `web/src/lib/__tests__/x3dhOracleVectors.test.ts`
//   - NYX → oracle: `web/src/lib/__tests__/x3dhOracleInterop.test.ts` (memanggil
//     worker NYX yang asli lalu menyerahkan hasilnya ke mode `-recipient` /
//     `-ratchet`; di-skip sendiri bila toolchain Go tidak ada)
//
// Mode:
//
//	-gen         cetak vektor JSON ke stdout (deterministik)
//	-write       bersama -gen: tulis ke path kanonik vektor
//	-check       bandingkan vektor di berkas dengan hasil regenerasi (gate drift)
//	-recipient   (interop) hitung ulang sessionKey sisi penerima dari blob NYX
//	-ratchet     (interop) dekapsulasi KEM NYX + buka AEAD NYX, lalu balikkan
//
// Semua kunci di vektor dibangkitkan deterministik dari label (tanpa randomness)
// dan HANYA untuk test. Jangan pernah memakai kunci dari vektor ini.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"

	"github.com/cloudflare/circl/kem/xwing"
	"github.com/cloudflare/circl/sign/mldsa/mldsa65"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
)

// ============================================================================
// Konstanta protokol NYX (harus sama persis dengan crypto.worker.ts)
// ============================================================================

const (
	handshakeMagic     = 0x4E // 'N' — HANDSHAKE_MAGIC
	handshakeVersion   = 0x01
	xwingCiphertextLen = 1120 // X_WING_CT_SIZE
	x25519PKLen        = 32
	paddingBlockSize   = 8192 // PADDING_BLOCK_SIZE
	aeadFinalOverhead  = 24 + 16
	vectorsRelPath     = "web/src/lib/__tests__/fixtures/x3dhOracleVectors.json"
	labelPrefix        = "nyx-dr-oracle/v1/"

	// [Fase 1.4 / docs/35 §35.6.2] Handshake v2: X-Wing murni + ML-DSA-65.
	handshakeV2Version  = 0x02
	handshakeV2FlagOTPK = 0x01
	handshakeV2Domain   = "NYX-PQ-HANDSHAKE-V2"
	mlDsa65PublicKeyLen = 1952 // ML_DSA_65_PUBLIC_KEY_BYTES
	mlDsa65SignatureLen = 3309 // ML_DSA_65_SIGNATURE_BYTES
)

// repoRoot: naik dari CWD sampai menemukan penanda root repo. Oracle dijalankan
// dari `tools/dr-oracle` (modul Go-nya sendiri), sedangkan vektor hidup di dalam
// `web/` — jadi path harus dihitung, bukan diasumsikan relatif CWD.
func repoRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			panic("root repo tidak ditemukan (tidak ada .git di atas CWD)")
		}
		dir = parent
	}
}

func vectorsPath() string { return filepath.Join(repoRoot(), filepath.FromSlash(vectorsRelPath)) }

// ============================================================================
// Primitif — semuanya dari pustaka non-libsodium
// ============================================================================

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func unb64(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

func mustB64(s string) []byte {
	b, err := unb64(s)
	if err != nil {
		panic(fmt.Errorf("base64url tidak sah: %w", err))
	}
	return b
}

// seedFor: materi kunci deterministik dari label. Tidak ada randomness di
// seluruh generator — vektor harus bisa diregenerasi bit-per-bit (gate `-check`).
func seedFor(label string) []byte {
	sum := sha256.Sum256([]byte(labelPrefix + label))
	return sum[:]
}

// seedFor64: seed 64 byte (ukuran `EncapsulationSeedSize` X-Wing). Nilai seed
// tidak perlu sama dengan libsodium (encaps NYX memakai randomness sendiri);
// yang penting di sini deterministik supaya vektor bisa diregenerasi.
func seedFor64(label string) []byte {
	out := append([]byte(nil), seedFor(label)...)
	return append(out, seedFor(label+"#2")...)
}

// x25519FromSeed: seed dipakai apa adanya sebagai scalar. libsodium
// (`crypto_box_seed_keypair`) juga menyimpan seed sebagai scalar dan men-clamp
// saat scalarmult; `curve25519.X25519` melakukan clamping yang sama.
func x25519FromSeed(seed []byte) (publicKey, privateKey []byte) {
	pub, err := curve25519.X25519(seed, curve25519.Basepoint)
	if err != nil {
		panic(err)
	}
	return pub, append([]byte(nil), seed...)
}

func x25519DH(privateKey, publicKey []byte) []byte {
	shared, err := curve25519.X25519(privateKey, publicKey)
	if err != nil {
		panic(fmt.Errorf("x25519 dh gagal: %w", err))
	}
	return shared
}

// ed25519FromSeed: layout private key 64 byte (seed||pk) persis seperti
// `crypto_sign_seed_keypair` libsodium.
func ed25519FromSeed(seed []byte) (publicKey, privateKey []byte) {
	priv := ed25519.NewKeyFromSeed(seed)
	return priv.Public().(ed25519.PublicKey), []byte(priv)
}

// ed25519SkToX25519: meniru `crypto_sign_ed25519_sk_to_curve25519` —
// SHA-512(seed) dipotong 32 byte, lalu di-clamp.
func ed25519SkToX25519(privateKey []byte) []byte {
	h := sha512.Sum512(privateKey[:32])
	scalar := append([]byte(nil), h[:32]...)
	scalar[0] &= 248
	scalar[31] &= 127
	scalar[31] |= 64
	return scalar
}

// ed25519PkToX25519: meniru `crypto_sign_ed25519_pk_to_curve25519` —
// u = (1+y)/(1-y) mod 2^255-19 (bit tanda x diabaikan). Diimplementasikan
// dengan aritmetika medan sendiri supaya tidak "meminjam" jawaban libsodium.
func ed25519PkToX25519(publicKey []byte) []byte {
	p := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	yBytes := append([]byte(nil), publicKey...)
	yBytes[31] &= 127
	y := leBytesToBig(yBytes)

	one := big.NewInt(1)
	num := new(big.Int).Add(one, y)
	num.Mod(num, p)
	den := new(big.Int).Sub(one, y)
	den.Mod(den, p)
	denInv := new(big.Int).ModInverse(den, p)
	if denInv == nil {
		panic("ed25519PkToX25519: pk tidak sah (penyebut tanpa invers)")
	}
	u := new(big.Int).Mul(num, denInv)
	u.Mod(u, p)
	return bigToLEBytes(u, 32)
}

func leBytesToBig(b []byte) *big.Int {
	rev := make([]byte, len(b))
	for i := range b {
		rev[i] = b[len(b)-1-i]
	}
	return new(big.Int).SetBytes(rev)
}

func bigToLEBytes(n *big.Int, size int) []byte {
	be := n.Bytes()
	out := make([]byte, size)
	for i := 0; i < len(be) && i < size; i++ {
		out[i] = be[len(be)-1-i]
	}
	return out
}

// xwingFromSeed: (pk 1216, sk 32) deterministik — circl. `DeriveKeyPairPacked`
// mengembalikan (sk, pk) sesuai KEM API circl.
func xwingFromSeed(seed []byte) (publicKey, privateKey []byte) {
	sk, pk := xwing.DeriveKeyPairPacked(seed)
	return pk, sk
}

// xwingEncapsulate: (ct 1120, ss 32). Perhatikan bahwa `xwing.Encapsulate`
// mengembalikan (ss, ct) — urutan TERBALIK dari API KEM circl, jadi dibalik di
// sini dan diberi nama eksplisit.
func xwingEncapsulate(publicKey, seed []byte) (ciphertext, sharedSecret []byte) {
	ss, ct, err := xwing.Encapsulate(publicKey, seed)
	if err != nil {
		panic(fmt.Errorf("xwing encaps gagal: %w", err))
	}
	return ct, ss
}

func xwingDecapsulate(ciphertext, privateKey []byte) []byte {
	if len(ciphertext) != xwingCiphertextLen {
		panic(fmt.Sprintf("xwing ct harus %d byte, dapat %d", xwingCiphertextLen, len(ciphertext)))
	}
	if len(privateKey) == 0 {
		panic("xwing sk kosong")
	}
	ss := xwing.Decapsulate(ciphertext, privateKey)
	if len(ss) != 32 {
		panic(fmt.Sprintf("xwing ss harus 32 byte, dapat %d", len(ss)))
	}
	return ss
}

// blake2bKeyed: crypto_generichash(outLen, input, key). 32 byte = BLAKE2b-256,
// 64 byte = BLAKE2b-512; `key` nil berarti mode tanpa kunci.
func blake2bKeyed(outLen int, input, key []byte) []byte {
	var h interface {
		io.Writer
		Sum([]byte) []byte
	}
	var err error
	switch outLen {
	case 32:
		h, err = blake2b.New256(key)
	case 64:
		h, err = blake2b.New512(key)
	default:
		panic("blake2bKeyed: panjang keluaran hanya 32 atau 64")
	}
	if err != nil {
		panic(err)
	}
	if _, err := h.Write(input); err != nil {
		panic(err)
	}
	return h.Sum(nil)
}

// kdfChain: mirror `kdfChain` worker — BLAKE2b-256 KEYED dengan chainKey sebagai
// kunci dan input 1 byte (0x01 pesan, 0x02 rantai berikutnya).
func kdfChain(chainKey []byte) (newChainKey, messageKey []byte) {
	return blake2bKeyed(32, []byte{0x02}, chainKey), blake2bKeyed(32, []byte{0x01}, chainKey)
}

// ============================================================================
// Bingkai handshake NYX (serializeHandshake/deserializeHandshake)
// ============================================================================

type handshake struct {
	ephemeralPublicKey []byte
	ctID               []byte
	ctSPK              []byte
	ctOTPK             []byte // nil bila tidak ada
}

func (h handshake) serialize() []byte {
	hasOTPK := len(h.ctOTPK) > 0
	flags := byte(0x00)
	if hasOTPK {
		flags = 0x01
	}
	size := 4 + x25519PKLen + xwingCiphertextLen*2
	if hasOTPK {
		size += xwingCiphertextLen
	}
	buf := make([]byte, size)
	buf[0] = handshakeMagic
	buf[1] = handshakeVersion
	buf[2] = flags
	buf[3] = 0x00
	offset := 4
	copy(buf[offset:], h.ephemeralPublicKey)
	offset += x25519PKLen
	copy(buf[offset:], h.ctID)
	offset += xwingCiphertextLen
	copy(buf[offset:], h.ctSPK)
	offset += xwingCiphertextLen
	if hasOTPK {
		copy(buf[offset:], h.ctOTPK)
	}
	return buf
}

func parseHandshake(buf []byte) handshake {
	minimum := 4 + x25519PKLen + xwingCiphertextLen*2
	if len(buf) < minimum {
		panic("handshake terlalu pendek")
	}
	if buf[0] != handshakeMagic {
		panic("magic handshake salah")
	}
	if buf[1] != handshakeVersion {
		panic("versi handshake tidak didukung")
	}
	hasOTPK := buf[2]&0x01 != 0
	offset := 4
	h := handshake{}
	h.ephemeralPublicKey = append([]byte(nil), buf[offset:offset+x25519PKLen]...)
	offset += x25519PKLen
	h.ctID = append([]byte(nil), buf[offset:offset+xwingCiphertextLen]...)
	offset += xwingCiphertextLen
	h.ctSPK = append([]byte(nil), buf[offset:offset+xwingCiphertextLen]...)
	offset += xwingCiphertextLen
	if hasOTPK {
		if len(buf) < offset+xwingCiphertextLen {
			panic("handshake mengaku punya OTPK tapi blob terpotong")
		}
		h.ctOTPK = append([]byte(nil), buf[offset:offset+xwingCiphertextLen]...)
	}
	return h
}

// ============================================================================
// X3DH sisi penerima
// ============================================================================

type recipientKeys struct {
	identityPrivateKey       []byte
	signedPreKeyPrivateKey   []byte
	pqIdentityPrivateKey     []byte
	pqSignedPreKeyPrivateKey []byte
	otpkClassicalPrivateKey  []byte
	otpkPqPrivateKey         []byte
}

// deriveRecipientSession: urutan WAJIB [dh1 dh2 dh3 ss_id ss_spk (dh4 ss_otpk)]
// → BLAKE2b-256 tanpa kunci.
func deriveRecipientSession(aliceSigningPublicKey []byte, k recipientKeys, h handshake) []byte {
	aliceIdentityX25519 := ed25519PkToX25519(aliceSigningPublicKey)

	dh1 := x25519DH(k.signedPreKeyPrivateKey, aliceIdentityX25519)
	dh2 := x25519DH(k.identityPrivateKey, h.ephemeralPublicKey)
	dh3 := x25519DH(k.signedPreKeyPrivateKey, h.ephemeralPublicKey)
	ssID := xwingDecapsulate(h.ctID, k.pqIdentityPrivateKey)
	ssSPK := xwingDecapsulate(h.ctSPK, k.pqSignedPreKeyPrivateKey)

	secrets := [][]byte{dh1, dh2, dh3, ssID, ssSPK}
	if len(h.ctOTPK) > 0 {
		if len(k.otpkClassicalPrivateKey) == 0 || len(k.otpkPqPrivateKey) == 0 {
			panic("blob memakai OTPK tapi kunci OTPK penerima tidak diberikan")
		}
		secrets = append(secrets, x25519DH(k.otpkClassicalPrivateKey, h.ephemeralPublicKey))
		secrets = append(secrets, xwingDecapsulate(h.ctOTPK, k.otpkPqPrivateKey))
	}
	return blake2bKeyed(32, bytes.Join(secrets, nil), nil)
}

// ============================================================================
// Traffic-cover padding (padBuffer worker; blok 8192−40)
// ============================================================================

func padBuffer(buf []byte, blockSize int) []byte {
	paddingLen := blockSize - (len(buf) % blockSize)
	out := make([]byte, len(buf)+paddingLen)
	copy(out, buf)
	out[len(buf)] = 0x80
	return out
}

func unpadBuffer(buf []byte, blockSize int) []byte {
	_ = blockSize
	i := len(buf) - 1
	for i >= 0 && buf[i] == 0 {
		i--
	}
	if i < 0 || buf[i] != 0x80 {
		return buf
	}
	return buf[:i]
}

// ============================================================================
// Vektor
// ============================================================================

type keyPair struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

type recipientVector struct {
	IdentityKey     keyPair `json:"identityKey"`
	SignedPreKey    keyPair `json:"signedPreKey"`
	PqIdentityKey   keyPair `json:"pqIdentityKey"`
	PqSignedPreKey  keyPair `json:"pqSignedPreKey"`
	OtpkClassical   keyPair `json:"otpkClassical,omitempty"`
	OtpkPq          keyPair `json:"otpkPq,omitempty"`
	OtpkPrivateJSON string  `json:"myOneTimePreKeyJson,omitempty"`
}

type x3dhVector struct {
	Name                  string `json:"name"`
	Note                  string `json:"note"`
	AliceSigningPublicKey string `json:"aliceSigningPublicKey"`
	// Kunci privat Alice ikut di vektor supaya NYX bisa berperan sebagai
	// inisiator di test interop (arah NYX → oracle). MATERIAL TEST.
	AliceSigningPrivateKey string `json:"aliceSigningPrivateKey"`
	// Sisi inisiator NYX memverifikasi TANDA TANGAN Bob atas signed pre-key
	// klasik & PQ-nya (`crypto_sign_verify_detached`) sebelum menghitung DH, jadi
	// vektor harus memuat kunci verifikasi Bob + tanda tangannya.
	BobSigningPublicKey     string          `json:"bobSigningPublicKey"`
	SignedPreKeySignature   string          `json:"signedPreKeySignature"`
	PqSignedPreKeySignature string          `json:"pqSignedPreKeySignature"`
	Bob                     recipientVector `json:"bob"`
	InitiatorCiphertexts    string          `json:"initiatorCiphertexts"`
	SessionKey              string          `json:"sessionKey"`
	EphemeralPublicKey      string          `json:"ephemeralPublicKey"`
}

type kdfVector struct {
	ChainKey    string `json:"chainKey"`
	MessageKey  string `json:"messageKey"`
	NewChainKey string `json:"newChainKey"`
}

type vectors struct {
	Version     int            `json:"version"`
	GeneratedBy string         `json:"generatedBy"`
	Warning     string         `json:"warning"`
	X3DH        []x3dhVector   `json:"x3dh"`
	X3DHV2      []x3dhV2Vector `json:"x3dhV2"`
	KdfChain    []kdfVector    `json:"kdfChain"`
}

func jsonIntArray(b []byte) string {
	parts := make([]string, len(b))
	for i, v := range b {
		parts[i] = fmt.Sprintf("%d", v)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func buildX3DHVector(name, note string, withOtpk bool) x3dhVector {
	aliceSigningPub, aliceSigningPriv := ed25519FromSeed(seedFor(name + "/alice-signing"))
	bobSigningPub, bobSigningPriv := ed25519FromSeed(seedFor(name + "/bob-signing"))
	bobIdentityPub, bobIdentityPriv := x25519FromSeed(seedFor(name + "/bob-identity"))
	bobSpkPub, bobSpkPriv := x25519FromSeed(seedFor(name + "/bob-spk"))
	bobPqIDPub, bobPqIDPriv := xwingFromSeed(seedFor(name + "/bob-pq-identity"))
	bobPqSpkPub, bobPqSpkPriv := xwingFromSeed(seedFor(name + "/bob-pq-spk"))
	otpkClassicalPub, otpkClassicalPriv := x25519FromSeed(seedFor(name + "/bob-otpk-classical"))
	otpkPqPub, otpkPqPriv := xwingFromSeed(seedFor(name + "/bob-otpk-pq"))
	ephemeralPub, ephemeralPriv := x25519FromSeed(seedFor(name + "/alice-ephemeral"))

	// Sisi inisiator (urutan worker): dh1 = IK_A × SPK_B, dh2 = EK_A × IK_B,
	// dh3 = EK_A × SPK_B, lalu ss_id, ss_spk.
	dh1 := x25519DH(ed25519SkToX25519(aliceSigningPriv), bobSpkPub)
	dh2 := x25519DH(ephemeralPriv, bobIdentityPub)
	dh3 := x25519DH(ephemeralPriv, bobSpkPub)
	ctID, ssID := xwingEncapsulate(bobPqIDPub, seedFor64(name+"/encaps-id"))
	ctSPK, ssSPK := xwingEncapsulate(bobPqSpkPub, seedFor64(name+"/encaps-spk"))
	secrets := [][]byte{dh1, dh2, dh3, ssID, ssSPK}

	h := handshake{ephemeralPublicKey: ephemeralPub, ctID: ctID, ctSPK: ctSPK}
	if withOtpk {
		dh4 := x25519DH(ephemeralPriv, otpkClassicalPub)
		ctOTPK, ssOTPK := xwingEncapsulate(otpkPqPub, seedFor64(name+"/encaps-otpk"))
		secrets = append(secrets, dh4, ssOTPK)
		h.ctOTPK = ctOTPK
	}

	sessionKey := blake2bKeyed(32, bytes.Join(secrets, nil), nil)

	// Sisi penerima dihitung ULANG dari blob yang sudah diserialisasi (bukan dari
	// variabel di atas) — ini membuktikan urutan & panjang sisi penerima cocok
	// dengan sisi inisiator di dalam oracle sendiri, sebelum NYX ikut diuji.
	recipient := recipientKeys{
		identityPrivateKey:       bobIdentityPriv,
		signedPreKeyPrivateKey:   bobSpkPriv,
		pqIdentityPrivateKey:     bobPqIDPriv,
		pqSignedPreKeyPrivateKey: bobPqSpkPriv,
	}
	blob := h.serialize()
	if withOtpk {
		recipient.otpkClassicalPrivateKey = otpkClassicalPriv
		recipient.otpkPqPrivateKey = otpkPqPriv
	}
	if derived := deriveRecipientSession(aliceSigningPub, recipient, parseHandshake(blob)); !bytes.Equal(derived, sessionKey) {
		panic("oracle tidak konsisten: sessionKey inisiator ≠ penerima")
	}

	v := x3dhVector{
		Name:                    name,
		Note:                    note,
		AliceSigningPublicKey:   b64(aliceSigningPub),
		AliceSigningPrivateKey:  b64(aliceSigningPriv),
		BobSigningPublicKey:     b64(bobSigningPub),
		SignedPreKeySignature:   b64(ed25519.Sign(bobSigningPriv, bobSpkPub)),
		PqSignedPreKeySignature: b64(ed25519.Sign(bobSigningPriv, bobPqSpkPub)),
		Bob: recipientVector{
			IdentityKey:    keyPair{PublicKey: b64(bobIdentityPub), PrivateKey: b64(bobIdentityPriv)},
			SignedPreKey:   keyPair{PublicKey: b64(bobSpkPub), PrivateKey: b64(bobSpkPriv)},
			PqIdentityKey:  keyPair{PublicKey: b64(bobPqIDPub), PrivateKey: b64(bobPqIDPriv)},
			PqSignedPreKey: keyPair{PublicKey: b64(bobPqSpkPub), PrivateKey: b64(bobPqSpkPriv)},
		},
		InitiatorCiphertexts: b64(blob),
		SessionKey:           b64(sessionKey),
		EphemeralPublicKey:   b64(ephemeralPub),
	}
	if withOtpk {
		v.Bob.OtpkClassical = keyPair{PublicKey: b64(otpkClassicalPub), PrivateKey: b64(otpkClassicalPriv)}
		v.Bob.OtpkPq = keyPair{PublicKey: b64(otpkPqPub), PrivateKey: b64(otpkPqPriv)}
		// Worker membungkus kunci OTPK sebagai teks JSON {"classical":[…],"pq":[…]}.
		v.Bob.OtpkPrivateJSON = fmt.Sprintf(`{"classical":%s,"pq":%s}`,
			jsonIntArray(otpkClassicalPriv), jsonIntArray(otpkPqPriv))
	}
	return v
}

// ============================================================================
// X3DH v2 (X-Wing murni + ML-DSA-65) — [Fase 1.4]
// ============================================================================

type mlDsaKey struct {
	publicKey  []byte
	privateKey *mldsa65.PrivateKey
}

// mlDsaFromSeed: FIPS 204 KeyGen deterministik dari seed 32 byte. NYX memakai
// `ml_dsa65.keygen(seed)` (noble) dengan seed yang sama.
func mlDsaFromSeed(seed []byte) mlDsaKey {
	var s [mldsa65.SeedSize]byte
	if len(seed) != mldsa65.SeedSize {
		panic(fmt.Sprintf("ml-dsa seed harus %d byte", mldsa65.SeedSize))
	}
	copy(s[:], seed)
	pk, sk := mldsa65.NewKeyFromSeed(&s)
	return mlDsaKey{publicKey: pk.Bytes(), privateKey: sk}
}

func mlDsaSign(sk *mldsa65.PrivateKey, message []byte) []byte {
	sig := make([]byte, mldsa65.SignatureSize)
	if err := mldsa65.SignTo(sk, message, []byte(handshakeV2Domain), false, sig); err != nil {
		panic(fmt.Errorf("ml-dsa sign gagal: %w", err))
	}
	return sig
}

func mlDsaVerify(pkBytes, message, signature []byte) bool {
	if len(pkBytes) != mlDsa65PublicKeyLen {
		panic(fmt.Sprintf("ml-dsa pk harus %d byte, dapat %d", mlDsa65PublicKeyLen, len(pkBytes)))
	}
	if len(signature) != mlDsa65SignatureLen {
		panic(fmt.Sprintf("ml-dsa sig harus %d byte, dapat %d", mlDsa65SignatureLen, len(signature)))
	}
	var pk mldsa65.PublicKey
	if err := pk.UnmarshalBinary(pkBytes); err != nil {
		panic(fmt.Errorf("ml-dsa pk tidak sah: %w", err))
	}
	return mldsa65.Verify(&pk, message, []byte(handshakeV2Domain), signature)
}

// lengthPrefixed: format transkrip v2 (u32 BE panjang + isi, per field).
func lengthPrefixed(fields ...[]byte) []byte {
	total := 0
	for _, f := range fields {
		total += 4 + len(f)
	}
	out := make([]byte, total)
	offset := 0
	for _, f := range fields {
		binary.BigEndian.PutUint32(out[offset:], uint32(len(f)))
		offset += 4
		copy(out[offset:], f)
		offset += len(f)
	}
	return out
}

// handshakeV2Transcript: [signingKeyV2(1952)][responderIdentityKey(32)][ctId][ctSpk][ctOtpk?]
// — HARUS sama persis dengan `buildHandshakeV2Transcript` (packages/shared/src/pqHandshake.ts).
func handshakeV2Transcript(initiatorSigningKeyV2, responderIdentityKey, ctID, ctSPK, ctOTPK []byte) []byte {
	if len(initiatorSigningKeyV2) != mlDsa65PublicKeyLen {
		panic("transkrip v2: signingKeyV2 panjang salah")
	}
	if len(responderIdentityKey) != x25519PKLen {
		panic("transkrip v2: responderIdentityKey panjang salah")
	}
	otpk := ctOTPK
	if otpk == nil {
		otpk = []byte{}
	}
	return lengthPrefixed(initiatorSigningKeyV2, responderIdentityKey, ctID, ctSPK, otpk)
}

// serializeHandshakeV2: [magic][version][flags][pad][ctId][ctSpk][ctOtpk?][signature].
func serializeHandshakeV2(ctID, ctSPK, ctOTPK, signature []byte) []byte {
	flags := byte(0)
	size := 4 + len(ctID) + len(ctSPK) + len(signature)
	if len(ctOTPK) > 0 {
		flags |= handshakeV2FlagOTPK
		size += len(ctOTPK)
	}
	out := make([]byte, size)
	out[0] = handshakeMagic
	out[1] = handshakeV2Version
	out[2] = flags
	out[3] = 0x00
	offset := 4
	copy(out[offset:], ctID)
	offset += len(ctID)
	copy(out[offset:], ctSPK)
	offset += len(ctSPK)
	if len(ctOTPK) > 0 {
		copy(out[offset:], ctOTPK)
		offset += len(ctOTPK)
	}
	copy(out[offset:], signature)
	return out
}

type x3dhV2Recipient struct {
	IdentityKey    keyPair `json:"identityKey"`
	PqIdentityKey  keyPair `json:"pqIdentityKey"`
	PqSignedPreKey keyPair `json:"pqSignedPreKey"`
	OtpkPq         keyPair `json:"otpkPq,omitempty"`
}

type x3dhV2Vector struct {
	Name string `json:"name"`
	Note string `json:"note"`
	// Kunci verifikasi ML-DSA inisiator (1952 byte) — dipakai NYX untuk
	// memverifikasi tanda tangan transkrip sebelum mendekapsulasi.
	AliceSigningV2PublicKey string `json:"aliceSigningV2PublicKey"`
	// Kunci privat Alice tidak dipakai test vektor, hanya material test
	// deterministik untuk arah NYX → oracle di masa depan.
	AliceSigningV2Seed   string          `json:"aliceSigningV2Seed"`
	Bob                  x3dhV2Recipient `json:"bob"`
	InitiatorCiphertexts string          `json:"initiatorCiphertexts"`
	SessionKey           string          `json:"sessionKey"`
}

// buildX3DHV2Vector: inisiator = oracle. Rahasia sesi = BLAKE2b-256(ss_id ‖ ss_spk [‖ ss_otpk])
// TANPA DH; tanda tangan ML-DSA mengikat transkrip. Sisi penerima dihitung ulang
// dari blob terserialisasi dan tanda tangannya diverifikasi ulang di dalam oracle
// sebelum vektor ditulis (self-consistency gate).
func buildX3DHV2Vector(name, note string, withOtpk bool) x3dhV2Vector {
	aliceSeed := seedFor(name + "/alice-signing-v2")
	aliceSigning := mlDsaFromSeed(aliceSeed)

	bobIdentityPub, bobIdentityPriv := x25519FromSeed(seedFor(name + "/bob-identity"))
	bobPqIDPub, bobPqIDPriv := xwingFromSeed(seedFor(name + "/bob-pq-identity"))
	bobPqSpkPub, bobPqSpkPriv := xwingFromSeed(seedFor(name + "/bob-pq-spk"))
	otpkPqPub, otpkPqPriv := xwingFromSeed(seedFor(name + "/bob-pq-otpk"))

	ctID, ssID := xwingEncapsulate(bobPqIDPub, seedFor64(name+"/encaps-v2-id"))
	ctSPK, ssSPK := xwingEncapsulate(bobPqSpkPub, seedFor64(name+"/encaps-v2-spk"))
	secrets := [][]byte{ssID, ssSPK}
	var ctOTPK []byte
	if withOtpk {
		var ssOTPK []byte
		ctOTPK, ssOTPK = xwingEncapsulate(otpkPqPub, seedFor64(name+"/encaps-v2-otpk"))
		secrets = append(secrets, ssOTPK)
	}

	sessionKey := blake2bKeyed(32, bytes.Join(secrets, nil), nil)
	transcript := handshakeV2Transcript(aliceSigning.publicKey, bobIdentityPub, ctID, ctSPK, ctOTPK)
	signature := mlDsaSign(aliceSigning.privateKey, transcript)
	blob := serializeHandshakeV2(ctID, ctSPK, ctOTPK, signature)

	// Self-check 1: tanda tangan oracle bisa diverifikasi oracle.
	if !mlDsaVerify(aliceSigning.publicKey, transcript, signature) {
		panic("oracle v2 tidak konsisten: tanda tangan transkrip tidak sah")
	}
	// Self-check 2: penerima menurunkan kunci yang sama dari blob.
	recipientSecrets := [][]byte{
		xwingDecapsulate(ctID, bobPqIDPriv),
		xwingDecapsulate(ctSPK, bobPqSpkPriv),
	}
	if withOtpk {
		recipientSecrets = append(recipientSecrets, xwingDecapsulate(ctOTPK, otpkPqPriv))
	}
	if derived := blake2bKeyed(32, bytes.Join(recipientSecrets, nil), nil); !bytes.Equal(derived, sessionKey) {
		panic("oracle v2 tidak konsisten: sessionKey inisiator ≠ penerima")
	}

	v := x3dhV2Vector{
		Name:                    name,
		Note:                    note,
		AliceSigningV2PublicKey: b64(aliceSigning.publicKey),
		AliceSigningV2Seed:      b64(aliceSeed),
		Bob: x3dhV2Recipient{
			IdentityKey:    keyPair{PublicKey: b64(bobIdentityPub), PrivateKey: b64(bobIdentityPriv)},
			PqIdentityKey:  keyPair{PublicKey: b64(bobPqIDPub), PrivateKey: b64(bobPqIDPriv)},
			PqSignedPreKey: keyPair{PublicKey: b64(bobPqSpkPub), PrivateKey: b64(bobPqSpkPriv)},
		},
		InitiatorCiphertexts: b64(blob),
		SessionKey:           b64(sessionKey),
	}
	if withOtpk {
		v.Bob.OtpkPq = keyPair{PublicKey: b64(otpkPqPub), PrivateKey: b64(otpkPqPriv)}
	}
	return v
}

func buildVectors() vectors {
	x3dh := []x3dhVector{
		buildX3DHVector("x3dh-plain", "tanpa One-Time Pre-Key (5 rahasia: dh1,dh2,dh3,ss_id,ss_spk)", false),
		buildX3DHVector("x3dh-with-otpk", "dengan One-Time Pre-Key (7 rahasia: + dh4, ss_otpk)", true),
	}

	x3dhV2 := []x3dhV2Vector{
		buildX3DHV2Vector("x3dh-v2-plain", "X-Wing murni tanpa OTPK (3 rahasia: ss_id, ss_spk) + ML-DSA-65", false),
		buildX3DHV2Vector("x3dh-v2-with-otpk", "X-Wing murni dengan OTPK (4 rahasia: ss_id, ss_spk, ss_otpk) + ML-DSA-65", true),
	}

	kdf := make([]kdfVector, 0, 4)
	ck := seedFor("kdf-chain/start")
	for i := 0; i < 4; i++ {
		next, mk := kdfChain(ck)
		kdf = append(kdf, kdfVector{ChainKey: b64(ck), MessageKey: b64(mk), NewChainKey: b64(next)})
		ck = next
	}

	return vectors{
		Version:     1,
		GeneratedBy: "tools/dr-oracle (Go: cloudflare/circl + x/crypto; TANPA libsodium)",
		Warning:     "Kunci di sini dibangkitkan deterministik dari label dan HANYA untuk test. Jangan dipakai di produksi.",
		X3DH:        x3dh,
		X3DHV2:      x3dhV2,
		KdfChain:    kdf,
	}
}

func marshalVectors(v vectors) []byte {
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		panic(err)
	}
	return append(out, '\n')
}

// ============================================================================
// Mode interop (dipanggil tools/dr-oracle/interop.mjs: arah NYX → oracle)
// ============================================================================

type interopReply struct {
	OK             bool   `json:"ok"`
	SessionKey     string `json:"sessionKey,omitempty"`
	Expected       string `json:"expected,omitempty"`
	Error          string `json:"error,omitempty"`
	CiphertextBack string `json:"ciphertextBack,omitempty"`
	Plaintext      string `json:"plaintext,omitempty"`
}

type interopRecipientRequest struct {
	AliceSigningPublicKey string          `json:"aliceSigningPublicKey"`
	Bob                   recipientVector `json:"bob"`
	InitiatorCiphertexts  string          `json:"initiatorCiphertexts"`
	SessionKey            string          `json:"sessionKey"`
}

func runRecipient(stdin io.Reader, stdout io.Writer) int {
	var req interopRecipientRequest
	if err := json.NewDecoder(stdin).Decode(&req); err != nil {
		writeJSON(stdout, interopReply{OK: false, Error: "request tidak sah: " + err.Error()})
		return 1
	}
	k := recipientKeys{
		identityPrivateKey:       mustB64(req.Bob.IdentityKey.PrivateKey),
		signedPreKeyPrivateKey:   mustB64(req.Bob.SignedPreKey.PrivateKey),
		pqIdentityPrivateKey:     mustB64(req.Bob.PqIdentityKey.PrivateKey),
		pqSignedPreKeyPrivateKey: mustB64(req.Bob.PqSignedPreKey.PrivateKey),
	}
	h := parseHandshake(mustB64(req.InitiatorCiphertexts))
	if len(h.ctOTPK) > 0 {
		var otpk struct {
			Classical []byte `json:"classical"`
			Pq        []byte `json:"pq"`
		}
		if err := json.Unmarshal([]byte(req.Bob.OtpkPrivateJSON), &otpk); err != nil {
			writeJSON(stdout, interopReply{OK: false, Error: "otpk json tidak sah: " + err.Error()})
			return 1
		}
		k.otpkClassicalPrivateKey = otpk.Classical
		k.otpkPqPrivateKey = otpk.Pq
	}

	derived := deriveRecipientSession(mustB64(req.AliceSigningPublicKey), k, h)
	expected := mustB64(req.SessionKey)
	reply := interopReply{OK: bytes.Equal(derived, expected), SessionKey: b64(derived), Expected: b64(expected)}
	if !reply.OK {
		reply.Error = "sessionKey oracle ≠ sessionKey NYX"
	}
	writeJSON(stdout, reply)
	if !reply.OK {
		return 1
	}
	return 0
}

type interopRatchetRequest struct {
	Sk                 string `json:"sk"`
	BobPqSpkPrivateKey string `json:"bobPqSpkPrivateKey"`
	SavedCt            string `json:"savedCt"`
	CKs                string `json:"ckS"`
	MessageKey         string `json:"messageKey"`
	Ciphertext         string `json:"ciphertext"`
	Plaintext          string `json:"plaintext"`
}

func runRatchet(stdin io.Reader, stdout io.Writer) int {
	var req interopRatchetRequest
	if err := json.NewDecoder(stdin).Decode(&req); err != nil {
		writeJSON(stdout, interopReply{OK: false, Error: "request tidak sah: " + err.Error()})
		return 1
	}
	sk := mustB64(req.Sk)

	// 1. Penerima menurunkan RK/CKs dari ct yang dibuat NYX (X-Wing decaps).
	ss := xwingDecapsulate(mustB64(req.SavedCt), mustB64(req.BobPqSpkPrivateKey))
	kdf := blake2bKeyed(64, append(append([]byte(nil), sk...), ss...), nil)
	_, cksBob := kdf[:32], kdf[32:]

	// 2. Rantai pesan pertama harus menghasilkan mk yang sama dengan NYX.
	_, mk := kdfChain(cksBob)
	okCKs := bytes.Equal(cksBob, mustB64(req.CKs))
	okMK := bytes.Equal(mk, mustB64(req.MessageKey))

	// 3. Buka ciphertext AEAD NYX dengan mk hasil oracle (nonce 24 byte di depan).
	aead, err := chacha20poly1305.NewX(mk)
	if err != nil {
		panic(err)
	}
	combined := mustB64(req.Ciphertext)
	if len(combined) < 24+16 {
		writeJSON(stdout, interopReply{OK: false, Error: "ciphertext terlalu pendek"})
		return 1
	}
	opened, openErr := aead.Open(nil, combined[:24], combined[24:], nil)
	plaintext := ""
	if openErr == nil {
		plaintext = string(unpadBuffer(opened, paddingBlockSize-aeadFinalOverhead))
	}

	// 4. Arah balik: oracle mengenkripsi plaintext yang sama dengan mk yang sama
	//    (nonce tetap deterministik) supaya NYX bisa membuka keluaran oracle.
	nonce := seedFor("interop/back-nonce")[:24]
	back := aead.Seal(nil, nonce, padBuffer([]byte(req.Plaintext), paddingBlockSize-aeadFinalOverhead), nil)

	ok := okCKs && okMK && openErr == nil && plaintext == req.Plaintext
	reply := interopReply{
		OK:             ok,
		CiphertextBack: b64(append(append([]byte(nil), nonce...), back...)),
		Plaintext:      plaintext,
	}
	switch {
	case !okCKs:
		reply.Error = "CKs oracle ≠ CKs NYX"
	case !okMK:
		reply.Error = "messageKey oracle ≠ messageKey NYX"
	case openErr != nil:
		reply.Error = "oracle gagal membuka ciphertext NYX: " + openErr.Error()
	case plaintext != req.Plaintext:
		reply.Error = "plaintext oracle ≠ plaintext NYX"
	}
	writeJSON(stdout, reply)
	if !ok {
		return 1
	}
	return 0
}

func writeJSON(w io.Writer, v interopReply) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// ============================================================================
// main
// ============================================================================

func main() {
	write := flag.Bool("write", false, "tulis vektor ke path kanonik (default: cetak ke stdout)")
	check := flag.Bool("check", false, "bandingkan vektor di berkas dengan regenerasi")
	recipient := flag.Bool("recipient", false, "mode interop: sessionKey sisi penerima")
	ratchet := flag.Bool("ratchet", false, "mode interop: ratchet + AEAD")
	flag.Parse()

	switch {
	case *check:
		path := vectorsPath()
		onDisk, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "gagal membaca %s: %v\n", path, err)
			os.Exit(1)
		}
		if !bytes.Equal(onDisk, marshalVectors(buildVectors())) {
			fmt.Fprintln(os.Stderr, "DRIFT: vektor di berkas berbeda dari hasil oracle. Jalankan ulang: go run ./tools/dr-oracle -write")
			os.Exit(1)
		}
		fmt.Println("OK: vektor oracle identik dengan hasil regenerasi")
	case *recipient:
		os.Exit(runRecipient(os.Stdin, os.Stdout))
	case *ratchet:
		os.Exit(runRatchet(os.Stdin, os.Stdout))
	default:
		data := marshalVectors(buildVectors())
		if *write {
			path := vectorsPath()
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				panic(err)
			}
			if err := os.WriteFile(path, data, 0o644); err != nil {
				panic(err)
			}
			fmt.Printf("vektor ditulis ke %s (%d byte)\n", path, len(data))
			return
		}
		if _, err := os.Stdout.Write(data); err != nil {
			panic(err)
		}
	}
}
