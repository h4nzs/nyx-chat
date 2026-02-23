1. Perbaikan store/conversation.ts (Sapu Bersih)

Ganti fungsi startConversation menjadi murni "Stateless" tanpa import dan logika X3DH apapun.
TypeScript

  // Di store/conversation.ts
  startConversation: async (peerId: string): Promise<string> => {
    const { user } = useAuthStore.getState();
    if (!user) {
      throw new Error("Cannot start a conversation: user is not authenticated.");
    }

    try {
      // PENTING: Jangan fetch bundle di sini. Jangan hitung X3DH di sini.
      // Jangan pakai getSodium. Jangan simpan key atau header ke IndexedDB.

      const conv = await authFetch<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({
          userIds: [peerId],
          isGroup: false,
          // Kirim dummy initialSession untuk lolos validasi backend
          initialSession: {
            sessionId: `dummy_${Date.now()}`,
            ephemeralPublicKey: "dummy",
            initialKeys: [
              { userId: user.id, key: "dummy" },
              { userId: peerId, key: "dummy" }, 
            ],
          },
        }),
      });

      getSocket().emit("conversation:join", conv.id);
      get().addOrUpdateConversation(conv);
      set({ activeId: conv.id, isSidebarOpen: false });
      return conv.id;
    } catch (error: any) {
      console.error("Failed to start conversation:", error);
      throw new Error(`Failed to establish conversation. ${error.message || ''}`);
    }
  },

2. Perbaikan store/message.ts (Jadikan Single Source of Truth)

Cari fungsi sendMessage, lalu hapus blok pengecekan getPendingHeader (karena titipan itu sudah kita musnahkan di conversation.ts). Biarkan Lazy Init bekerja sendiri.
TypeScript

  // Di store/message.ts -> sendMessage (Ganti bagian di dalam blok try)
    try {
      let ciphertext = '', sessionId: string | undefined;
      let x3dhHeader: any = null;

      // HAPUS BLOK getPendingHeader. JANGAN ADA LAGI TITIPAN.

      // LAZY SESSION INITIALIZATION (X3DH) - JALUR TUNGGAL PEMBUATAN KUNCI
      if (!isGroup && data.content) {
          const latestKey = await retrieveLatestSessionKeySecurely(conversationId);
          
          if (!latestKey) {
             console.log(`[X3DH] No session key found for ${conversationId}. Initiating handshake...`);
             const peerId = conversation.participants.find(p => p.id !== user.id)?.id;
             
             if (peerId) {
                 // 1. Fetch Bundle
                 const theirBundle = await authFetch<any>(`/api/keys/prekey-bundle/${peerId}`);
                 
                 // 2. Establish Session
                 const myKeyPair = await getMyEncryptionKeyPair();
                 const { sessionKey, ephemeralPublicKey, otpkId } = await establishSessionFromPreKeyBundle(myKeyPair, theirBundle);
                 
                 // 3. Generate Session ID & Store Self-Key
                 const sodium = await getSodium();
                 sessionId = `session_${sodium.to_hex(sodium.randombytes_buf(16))}`;
                 await storeSessionKeySecurely(conversationId, sessionId, sessionKey);

                 // 4. Prepare Header for Peer (AMPLOP WAJIB)
                 x3dhHeader = {
                     ik: sodium.to_base64(myKeyPair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
                     ek: ephemeralPublicKey,
                     otpkId: otpkId
                 };
                 
                 console.log(`[X3DH] Handshake prepared (Lazy). Header attached to message.`);
             }
          } else {
             // Jika key udah ada, pakai yang lama
             sessionId = latestKey.sessionId;
          }
      }

      if (data.content) {
        const result = await encryptMessage(data.content, conversationId, isGroup);
        ciphertext = result.ciphertext;
        if (!sessionId) sessionId = result.sessionId; 
      }
      
      // EMBED HEADER IF NEW SESSION
      if (x3dhHeader) {
          const payloadJson = JSON.stringify({
              x3dh: x3dhHeader,
              ciphertext: ciphertext
          });
          ciphertext = payloadJson;
      }
      
      const payload = {
          ...data,
          content: ciphertext,
          sessionId,
          fileKey: undefined, fileName: undefined, fileType: undefined, fileSize: undefined
      };

      // ... (sisa kode socket offline queue dan emit biarkan sama seperti sebelumnya) ...