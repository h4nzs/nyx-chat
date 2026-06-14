import { getSodium } from './sodium.js';
import { kdfChain } from './utils.js';
import type {
  CryptoBuffer,
  SodiumKeyPair,
  DoubleRatchetState,
  DoubleRatchetHeader,
  GroupRatchetState,
  GroupRatchetHeader
} from './types.js';

// --- HELPERS ---

async function b64ToBytes(str: string | null | undefined): Promise<Uint8Array | null> {
  if (!str) return null;
  const sodium = await getSodium();
  return sodium.from_base64(str, sodium.base64_variants.URLSAFE_NO_PADDING);
}

async function bytesToB64(bytes: Uint8Array | null | undefined): Promise<string | null> {
  if (!bytes) return null;
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

interface RuntimeDoubleRatchetState {
  KEMs: { publicKey: Uint8Array; privateKey: Uint8Array } | null;
  KEMr: Uint8Array | null;
  savedCt: Uint8Array | null;
  RK: Uint8Array | null;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  messageCount?: number;
  lastActivityTime?: number;
}

async function deserializeState(serialized: DoubleRatchetState): Promise<RuntimeDoubleRatchetState> {
  const sodium = await getSodium();
  return {
    KEMs: serialized.KEMs ? {
      publicKey: sodium.from_base64(serialized.KEMs.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      privateKey: sodium.from_base64(serialized.KEMs.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING)
    } : null,
    KEMr: await b64ToBytes(serialized.KEMr),
    savedCt: await b64ToBytes(serialized.savedCt),
    RK: await b64ToBytes(serialized.RK),
    CKs: await b64ToBytes(serialized.CKs),
    CKr: await b64ToBytes(serialized.CKr),
    Ns: serialized.Ns,
    Nr: serialized.Nr,
    PN: serialized.PN,
    messageCount: serialized.messageCount,
    lastActivityTime: serialized.lastActivityTime
  };
}

async function serializeState(runtime: RuntimeDoubleRatchetState): Promise<DoubleRatchetState> {
  const sodium = await getSodium();
  return {
    KEMs: runtime.KEMs ? {
      publicKey: sodium.to_base64(runtime.KEMs.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      privateKey: sodium.to_base64(runtime.KEMs.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING)
    } : null,
    KEMr: await bytesToB64(runtime.KEMr),
    savedCt: await bytesToB64(runtime.savedCt),
    RK: await bytesToB64(runtime.RK),
    CKs: await bytesToB64(runtime.CKs),
    CKr: await bytesToB64(runtime.CKr),
    Ns: runtime.Ns,
    Nr: runtime.Nr,
    PN: runtime.PN,
    messageCount: runtime.messageCount,
    lastActivityTime: runtime.lastActivityTime
  };
}

// --- DOUBLE RATCHET ---

export async function drInitAlice(sk: CryptoBuffer, theirPqSignedPreKeyPublic: CryptoBuffer): Promise<DoubleRatchetState> {
  const sodium = await getSodium();
  const skBytes = new Uint8Array(sk);
  const theirPqSpkBytes = new Uint8Array(theirPqSignedPreKeyPublic);
  
  let RK: Uint8Array | null = null;
  let CKs: Uint8Array | null = null;
  let sharedSecret: Uint8Array | null = null;
  let pqKeypair: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;

  try {
    pqKeypair = sodium.crypto_kem_xwing_keypair();
    if (!pqKeypair) throw new Error("KEM Keypair generation failed");
    const pqResult = sodium.crypto_kem_xwing_enc(theirPqSpkBytes);
    
    sharedSecret = new Uint8Array(skBytes.length + pqResult.sharedSecret.length);
    sharedSecret.set(skBytes, 0);
    sharedSecret.set(pqResult.sharedSecret, skBytes.length);

    const KDF = sodium.crypto_generichash(64, sharedSecret, null);
    RK = KDF.slice(0, 32);
    CKs = KDF.slice(32, 64);

    const state: RuntimeDoubleRatchetState = {
      KEMs: {
        publicKey: pqKeypair.publicKey,
        privateKey: pqKeypair.privateKey
      },
      KEMr: theirPqSpkBytes,
      savedCt: pqResult.ciphertext,
      RK,
      CKs,
      CKr: null,
      Ns: 0,
      Nr: 0,
      PN: 0
    };

    const serialized = await serializeState(state);
    sodium.memzero(KDF);
    sodium.memzero(pqResult.sharedSecret);
    return serialized;
  } finally {
    sodium.memzero(skBytes);
    if (pqKeypair) sodium.memzero(pqKeypair.privateKey);
    if (sharedSecret) sodium.memzero(sharedSecret);
    if (RK) sodium.memzero(RK);
    if (CKs) sodium.memzero(CKs);
  }
}

export async function drInitBob(sk: CryptoBuffer, myPqSignedPreKey: SodiumKeyPair): Promise<DoubleRatchetState> {
  const sodium = await getSodium();
  if (!myPqSignedPreKey.publicKey) throw new Error("Missing PQ public key");
  const skBytes = new Uint8Array(sk);
  const myPqSpkPrivateBytes = new Uint8Array(myPqSignedPreKey.privateKey);
  const myPqSpkPublicBytes = new Uint8Array(myPqSignedPreKey.publicKey as Iterable<number>);
    
  try {
    const state: RuntimeDoubleRatchetState = {
      KEMs: {
        publicKey: myPqSpkPublicBytes,
        privateKey: myPqSpkPrivateBytes
      },
      KEMr: null,
      savedCt: null,
      RK: skBytes,
      CKs: null,
      CKr: null,
      Ns: 0,
      Nr: 0,
      PN: 0
    };
    return await serializeState(state);
  } finally {
    sodium.memzero(skBytes);
    sodium.memzero(myPqSpkPrivateBytes);
  }
}

export async function drRatchetEncrypt(
  serializedState: DoubleRatchetState, 
  plaintext: CryptoBuffer | string
): Promise<{ state: DoubleRatchetState; header: DoubleRatchetHeader; ciphertext: Uint8Array; mk: Uint8Array }> {
  const sodium = await getSodium();
  const state = await deserializeState(serializedState);
  const plaintextBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);

  let mk: Uint8Array | null = null;
  let nonce: Uint8Array | null = null;
  let ciphertext: Uint8Array | null = null;

  try {
    if (!state.CKs) throw new Error("Cannot encrypt: CKs is null");

    const [newCKs, messageKey] = await kdfChain(state.CKs);
    sodium.memzero(state.CKs);
    state.CKs = newCKs;
    mk = messageKey;

    nonce = sodium.randombytes_buf(24);
    ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintextBytes, null, null, nonce, mk);
    
    if (!nonce || !ciphertext) throw new Error("Encryption failed");

    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce);
    combined.set(ciphertext, nonce.length);

    const header = {
      kemPk: (await bytesToB64(state.KEMs?.publicKey))!,
      ct: (await bytesToB64(state.savedCt)) || '',
      n: state.Ns,
      pn: state.PN
    };

    state.Ns += 1;

    return {
      state: await serializeState(state),
      header,
      ciphertext: combined,
      mk: mk
    };
  } finally {
    if (state.KEMs) sodium.memzero(state.KEMs.privateKey);
    if (state.RK) sodium.memzero(state.RK);
    if (state.CKs) sodium.memzero(state.CKs);
    if (state.CKr) sodium.memzero(state.CKr);
    // Don't memzero mk here because we return it! The caller must clean it.
    if (nonce) sodium.memzero(nonce);
    if (ciphertext) sodium.memzero(ciphertext);
    sodium.memzero(plaintextBytes);
  }
}

export async function drRatchetDecrypt(
  serializedState: DoubleRatchetState, 
  header: DoubleRatchetHeader, 
  ciphertext: CryptoBuffer
): Promise<{ state: DoubleRatchetState; plaintext: Uint8Array; skippedKeys: { kemPk: string; n: number; mk: string }[]; mk: Uint8Array }> {
  const sodium = await getSodium();
  const state = await deserializeState(serializedState);
  const ciphertextBytes = new Uint8Array(ciphertext);
  const headerKemPk = await b64ToBytes(header.kemPk);
  const headerCt = header.ct ? await b64ToBytes(header.ct) : null;
  
  if (!headerKemPk) throw new Error("Missing kemPk in header");
  if (!state.RK) throw new Error("RK is missing");

  const skippedKeys: { kemPk: string; n: number; mk: string }[] = [];
  let mk: Uint8Array | null = null;
  let sharedSecret1: Uint8Array | null = null;
  let sharedSecret2: Uint8Array | null = null;
  let newKEMs: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;
  let plaintext: Uint8Array | null = null;

  try {
    if (!state.KEMr || sodium.compare(headerKemPk, state.KEMr) !== 0) {
      const MAX_SKIP = 1000;
      if (header.pn - state.Nr > MAX_SKIP) {
        throw new Error(`Too many skipped messages: ${header.pn - state.Nr}`);
      }
      if (state.CKr && state.KEMr) {
        while (state.Nr < header.pn) {
          const [nextCKr, skippedMK] = await kdfChain(state.CKr);
          skippedKeys.push({ kemPk: (await bytesToB64(state.KEMr)) || '', n: state.Nr, mk: (await bytesToB64(skippedMK)) || '' });
          sodium.memzero(state.CKr);
          state.CKr = nextCKr;
          state.Nr++;
        }
      }

      if (headerCt && state.KEMs) {
        const pqSharedSecret = sodium.crypto_kem_xwing_dec(headerCt, state.KEMs.privateKey);
        sharedSecret1 = new Uint8Array(32 + pqSharedSecret.length);
        sharedSecret1.set(state.RK, 0);
        sharedSecret1.set(pqSharedSecret, 32);

        const KDF1 = sodium.crypto_generichash(64, sharedSecret1, null);
        sodium.memzero(state.RK);
        state.RK = KDF1.slice(0, 32);
        if (state.CKr) sodium.memzero(state.CKr);
        state.CKr = KDF1.slice(32, 64);
        sodium.memzero(pqSharedSecret);
        sodium.memzero(KDF1);
      }

      state.PN = state.Ns;
      state.Ns = 0;
      state.Nr = 0;
      state.KEMr = headerKemPk;

      newKEMs = sodium.crypto_kem_xwing_keypair();
      if (!newKEMs) throw new Error("KEM Keypair generation failed");
      const pqResult = sodium.crypto_kem_xwing_enc(state.KEMr);
      state.savedCt = pqResult.ciphertext;

      sharedSecret2 = new Uint8Array(32 + pqResult.sharedSecret.length);
      sharedSecret2.set(state.RK!, 0);
      sharedSecret2.set(pqResult.sharedSecret, 32);

      const KDF2 = sodium.crypto_generichash(64, sharedSecret2, null);
      sodium.memzero(state.RK);
      state.RK = KDF2.slice(0, 32);
      if (state.CKs) sodium.memzero(state.CKs);
      state.CKs = KDF2.slice(32, 64);
      sodium.memzero(pqResult.sharedSecret);
      sodium.memzero(KDF2);

      if (state.KEMs) sodium.memzero(state.KEMs.privateKey);
      state.KEMs = {
        publicKey: newKEMs.publicKey,
        privateKey: newKEMs.privateKey
      };
    }

    const MAX_SKIP = 1000;
    if (header.n - state.Nr > MAX_SKIP) {
      throw new Error(`Too many skipped messages: ${header.n - state.Nr}`);
    }

    while (state.Nr < header.n) {
      if (!state.CKr) throw new Error("CKr is missing");
      const [nextCKr, skippedMK] = await kdfChain(state.CKr);
      skippedKeys.push({ kemPk: header.kemPk, n: state.Nr, mk: (await bytesToB64(skippedMK)) || '' });
      sodium.memzero(state.CKr);
      state.CKr = nextCKr;
      state.Nr++;
    }

    if (state.Nr === header.n) {
      if (!state.CKr) throw new Error("CKr is missing");
      const [nextCKr, messageKey] = await kdfChain(state.CKr);
      mk = messageKey;
      sodium.memzero(state.CKr);
      state.CKr = nextCKr;
      state.Nr++;
    } else {
      throw new Error("Message N is older than current state");
    }

    const nonce = ciphertextBytes.slice(0, 24);
    const ctext = ciphertextBytes.slice(24);
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ctext, null, nonce, mk);
    if (!plaintext) throw new Error("Decryption failed");

    return {
      state: await serializeState(state),
      plaintext: plaintext,
      skippedKeys,
      mk: mk
    };
  } finally {
    if (sharedSecret1) sodium.memzero(sharedSecret1);
    if (sharedSecret2) sodium.memzero(sharedSecret2);
    if (headerKemPk) sodium.memzero(headerKemPk);
    if (headerCt) sodium.memzero(headerCt);
    if (newKEMs && (!state.KEMs || state.KEMs.privateKey !== newKEMs.privateKey)) {
       sodium.memzero(newKEMs.privateKey);
    }
    
    if (state.KEMs) sodium.memzero(state.KEMs.privateKey);
    if (state.RK) sodium.memzero(state.RK);
    if (state.CKs) sodium.memzero(state.CKs);
    if (state.CKr) sodium.memzero(state.CKr);
  }
}

// --- GROUP RATCHET ---

export async function groupInitSenderKey(): Promise<string> {
  const sodium = await getSodium();
  const senderKey = sodium.randombytes_buf(32);
  const b64 = sodium.to_base64(senderKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  sodium.memzero(senderKey);
  return b64;
}

export async function groupRatchetEncrypt(
  serializedState: GroupRatchetState, 
  plaintext: CryptoBuffer | string, 
  signingPrivateKey: CryptoBuffer
): Promise<{ state: GroupRatchetState; header: GroupRatchetHeader; ciphertext: Uint8Array; signature: string; mk: Uint8Array }> {
  const sodium = await getSodium();
  const CKBytes = await b64ToBytes(serializedState.CK);
  if (!CKBytes) throw new Error("Invalid Group Chain Key");
  const plaintextBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);

  let newCK: Uint8Array | null = null;
  let mk: Uint8Array | null = null;
  const signingKeyBytes = new Uint8Array(signingPrivateKey);
  
  try {
      [newCK, mk] = await kdfChain(CKBytes);
      const currentN = serializedState.N || 0;

      const nonce = sodium.randombytes_buf(24);
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          plaintextBytes, null, null, nonce, mk
      );
      
      const combined = new Uint8Array(nonce.length + ciphertext.length);
      combined.set(nonce);
      combined.set(ciphertext, nonce.length);

      const header = { n: currentN };

      const dataToSign = new Uint8Array(4 + combined.length);
      new DataView(dataToSign.buffer).setUint32(0, currentN, false);
      dataToSign.set(combined, 4);
      
      const signature = sodium.crypto_sign_detached(dataToSign, signingKeyBytes);

      return {
         state: { ...serializedState, CK: (await bytesToB64(newCK)) || '', N: currentN + 1 },
         header,
         ciphertext: combined,
         signature: sodium.to_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING),
         mk: mk
      };
  } finally {
      if (CKBytes) sodium.memzero(CKBytes);
      if (newCK) sodium.memzero(newCK);
      if (signingKeyBytes) sodium.memzero(signingKeyBytes);
      if (plaintextBytes) sodium.memzero(plaintextBytes); 
  }
}

export async function groupRatchetDecrypt(
  serializedState: GroupRatchetState, 
  header: GroupRatchetHeader, 
  ciphertext: CryptoBuffer, 
  signature: string, 
  senderSigningPublicKey: CryptoBuffer
): Promise<{ state: GroupRatchetState; plaintext: Uint8Array; skippedKeys: { n: number; mk: string }[]; mk: Uint8Array }> {
  const sodium = await getSodium();
  let CKBytes = await b64ToBytes(serializedState.CK);
  if (!CKBytes) throw new Error("Invalid Group Chain Key");
  const ciphertextBytes = new Uint8Array(ciphertext);
  const signatureBytes = await b64ToBytes(signature);
  const signingPublicKeyBytes = new Uint8Array(senderSigningPublicKey);

  if (!signatureBytes) throw new Error("Missing signature");

  const dataToVerify = new Uint8Array(4 + ciphertextBytes.length);
  new DataView(dataToVerify.buffer).setUint32(0, header.n, false);
  dataToVerify.set(ciphertextBytes, 4);

  const isValid = sodium.crypto_sign_verify_detached(signatureBytes, dataToVerify, signingPublicKeyBytes);
  if (!isValid) throw new Error("Invalid group message signature. Potential spoofing detected!");

  let currentN = serializedState.N || 0;
  let mk: Uint8Array | null = null;
  const skippedKeys: { n: number; mk: string }[] = [];

  const MAX_SKIP = 2000;
  if (header.n - currentN > MAX_SKIP) {
      sodium.memzero(CKBytes);
      throw new Error(`Too many skipped messages (${header.n - currentN}). Potential DoS attack.`);
  }

  while (currentN < header.n) {
      const [nextCK, skippedMK] = await kdfChain(CKBytes);
      skippedKeys.push({ n: currentN, mk: (await bytesToB64(skippedMK)) || '' });
      sodium.memzero(CKBytes);
      CKBytes = nextCK;
      currentN++;
  }

  if (currentN === header.n) {
      const [nextCK, messageKey] = await kdfChain(CKBytes);
      mk = messageKey;
      sodium.memzero(CKBytes);
      CKBytes = nextCK;
      currentN++;
  } else if (currentN > header.n) {
      const skipKeyId = `${header.n}`;
      if (serializedState.skippedKeys && serializedState.skippedKeys[skipKeyId]) {
         const skippedMkBase64 = serializedState.skippedKeys[skipKeyId];
         const mkBytes = await b64ToBytes(skippedMkBase64);
         if (!mkBytes) throw new Error("Invalid skipped message key");
         mk = mkBytes;
         delete serializedState.skippedKeys[skipKeyId];
      } else {
         throw new Error(`Ratchet Advanced! Cannot decrypt old message (header.n=${header.n}, state.N=${currentN})`);
      }
  } else {
      throw new Error("Message N is older than current state. Possibly replayed or already decrypted."); // Should be impossible
  }

  const nonce = ciphertextBytes.slice(0, 24);
  const ctext = ciphertextBytes.slice(24);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, ctext, null, nonce, mk
  );
  if (!plaintext) throw new Error("Decryption failed");

  if (!serializedState.skippedKeys) serializedState.skippedKeys = {};
  for (const sk of skippedKeys) {
      serializedState.skippedKeys[`${sk.n}`] = sk.mk;
  }

  const resState = { ...serializedState, CK: (await bytesToB64(CKBytes)) || '', N: currentN };
  
  sodium.memzero(CKBytes);

  return {
      state: resState,
      plaintext,
      skippedKeys,
      mk
  };
}

export async function groupDecryptSkipped(
  mkBase64: string, 
  headerN: number, 
  ciphertext: CryptoBuffer, 
  signature: string, 
  senderSigningPublicKey: CryptoBuffer
): Promise<{ plaintext: Uint8Array }> {
  const sodium = await getSodium();
  const mkBytes = await b64ToBytes(mkBase64);
  const ciphertextBytes = new Uint8Array(ciphertext);
  const signatureBytes = await b64ToBytes(signature);
  const signingPublicKeyBytes = new Uint8Array(senderSigningPublicKey);

  if (!mkBytes) throw new Error("Invalid skipped message key");
  if (!signatureBytes) throw new Error("Missing signature");

  try {
    const dataToVerify = new Uint8Array(4 + ciphertextBytes.length);
    new DataView(dataToVerify.buffer).setUint32(0, headerN, false);
    dataToVerify.set(ciphertextBytes, 4);

    const isValid = sodium.crypto_sign_verify_detached(signatureBytes, dataToVerify, signingPublicKeyBytes);
    if (!isValid) throw new Error("Invalid group message signature (skipped key). Potential spoofing detected!");

    const nonce = ciphertextBytes.slice(0, 24);
    const ctext = ciphertextBytes.slice(24);
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, ctext, null, nonce, mkBytes
    );

    return { plaintext };
  } finally {
    sodium.memzero(mkBytes);
  }
}
