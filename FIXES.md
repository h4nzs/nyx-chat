*"Kita akan menyelesaikan Phase 4: 'The Key Delivery' dengan menyisipkan ProfileKey pengirim ke dalam payload pesan Double Ratchet, sehingga penerima dapat mendekripsi profil pengirim secara otomatis.*

*Tolong modifikasi file `web/src/store/message.ts` dengan presisi pada 3 titik berikut:*

### STEP 1: Modifikasi fungsi `sendMessage` (Menyisipkan ProfileKey)

Cari bagian di mana pesan dienkripsi:

```typescript
      let mkToStore: Uint8Array | undefined;

      if (data.content) {
        // Encrypt content

```

Ganti logika pembentukan `content` sebelum dikirim ke `encryptMessage` menjadi seperti ini:

```typescript
      let mkToStore: Uint8Array | undefined;
      let contentToEncrypt = data.content;

      if (contentToEncrypt) {
        // --- INJEKSI PROFILE KEY ---
        try {
            const profileKey = await import('@lib/keychainDb').then(m => m.getProfileKey(user.id));
            if (profileKey) {
                let parsedObj: any = null;
                if (contentToEncrypt.trim().startsWith('{')) {
                    try { parsedObj = JSON.parse(contentToEncrypt); } catch (e) {}
                }
                
                if (parsedObj && typeof parsedObj === 'object') {
                    parsedObj.profileKey = profileKey;
                    contentToEncrypt = JSON.stringify(parsedObj);
                } else {
                    contentToEncrypt = JSON.stringify({ text: contentToEncrypt, profileKey });
                }
            }
        } catch (e) {
            console.error("Failed to inject profile key", e);
        }
        // ---------------------------

        // Encrypt content (gunakan contentToEncrypt)
        const result = await encryptMessage(contentToEncrypt, conversationId, isGroup, undefined, `temp_${actualTempId}`);

```

### STEP 2: Modifikasi `decryptMessageObject` - Main Branch (Mengekstrak ProfileKey)

Cari blok di mana hasil dekripsi Double Ratchet sukses:

```typescript
    // 5. Proses Hasil
    if (result?.status === 'success') {
      const plainText = result.value;
      decryptedMsg.content = plainText;

```

Ubah menjadi seperti ini untuk menangkap dan menyimpan ProfileKey:

```typescript
    // 5. Proses Hasil
    if (result?.status === 'success') {
      let plainText = result.value;

      // --- EKSTRAKSI PROFILE KEY DARI PENERIMA ---
      if (plainText && plainText.trim().startsWith('{')) {
          try {
              const parsed = JSON.parse(plainText);
              if (parsed.profileKey) {
                  import('@lib/keychainDb').then(m => m.saveProfileKey(decryptedMsg.senderId, parsed.profileKey));
                  import('@store/profile').then(m => m.useProfileStore.getState().decryptAndCache(decryptedMsg.senderId, decryptedMsg.sender?.encryptedProfile || null));
                  
                  delete parsed.profileKey;
                  
                  if (parsed.text !== undefined && Object.keys(parsed).length === 1) {
                      plainText = parsed.text;
                  } else {
                      plainText = JSON.stringify(parsed);
                  }
              }
          } catch (e) {}
      }
      // ------------------------------------------

      decryptedMsg.content = plainText;

```

### STEP 3: Modifikasi `decryptMessageObject` - Self Message Branch

Cari bagian dekripsi pesan sendiri (di awal try block):

```typescript
                const decryptedBytes = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
                
                decryptedMsg.content = sodium.to_string(decryptedBytes);

```

Ubah menjadi seperti ini agar pesan sendiri yang berformat JSON wrapper tidak tampil sebagai objek string di UI:

```typescript
                const decryptedBytes = await worker_crypto_secretbox_xchacha20poly1305_open_easy(encrypted, nonce, mk);
                let plainText = sodium.to_string(decryptedBytes);
                
                // --- STRIP PROFILE KEY DARI PESAN SENDIRI ---
                if (plainText && plainText.trim().startsWith('{')) {
                    try {
                        const parsed = JSON.parse(plainText);
                        if (parsed.profileKey) {
                            delete parsed.profileKey;
                            if (parsed.text !== undefined && Object.keys(parsed).length === 1) {
                                plainText = parsed.text;
                            } else {
                                plainText = JSON.stringify(parsed);
                            }
                        }
                    } catch (e) {}
                }
                // --------------------------------------------
                
                decryptedMsg.content = plainText;

```

*Terapkan modifikasi ini dengan hati-hati agar tidak merusak logika X3DH yang ada di dalam `decryptMessageObject` dan `sendMessage`.*"
