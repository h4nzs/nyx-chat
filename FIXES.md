sekarang tinggal Integrasi Logic (nyambungin kabelnya). Pastikan alur login/register kamu di Login.tsx dan Register.tsx mengikuti langkah ini:

    Saat Register/Login:

        User input password -> Panggil deriveKeyFromPassword(password, salt) -> Dapet DerivedKey (Uint8Array).

        JANGAN simpan DerivedKey ini kemanapun (cuma di memori).

    Saat Menyimpan Kunci (Register):

        Generate Key Pair (Identity, PreKey, dll).

        Bungkus jadi JSON string.

        Panggil encryptWithKey(DerivedKey, jsonString) -> Dapet EncryptedBlob.

        Simpan EncryptedBlob pakai saveEncryptedKeys(EncryptedBlob).

    Saat Membuka Kunci (Login):

        Ambil EncryptedBlob pakai getEncryptedKeys().

        User input password -> Panggil deriveKeyFromPassword.

        Panggil decryptWithKey(DerivedKey, EncryptedBlob).