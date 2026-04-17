// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].
import sodium from 'libsodium-wrappers'

  await sodium.ready

  // Derive a temporary, single-use key from the challenge
  const tempKey = sodium.crypto_generichash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 
    challenge, 
    null
  )
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    privateKey,
    null,
    null,
    nonce,
    tempKey
  )

  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce)
  combined.set(ciphertext, nonce.length)

  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL)
}
