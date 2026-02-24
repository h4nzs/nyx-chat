*"Mari kita implementasikan arsitektur 'Zero-Knowledge Password Reset' untuk fitur Recovery Phrase. Kita akan menggunakan `signingPrivateKey` yang di-generate ulang dari Phrase untuk menandatangani sebuah payload otorisasi, lalu server akan memverifikasinya menggunakan `signingPublicKey` yang tersimpan di database.*

*Tolong eksekusi 4 langkah perubahan ini secara presisi:*

### 1. Update Worker (`web/src/workers/crypto.worker.ts`)

*Tambahkan sebuah case baru di dalam `self.onmessage` untuk menangani regenerasi kunci dan pembuatan Digital Signature sekaligus:*

```typescript
      case 'recoverAccountWithSignature': {
        const { phrase, newPassword, identifier, timestamp } = payload;
        const masterSeedHex = bip39.mnemonicToEntropy(phrase);
        const masterSeed = sodium.from_hex(masterSeedHex);

        const encryptionSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("encryption")));
        const signingSeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signing")));
        const signedPreKeySeed = sodium.crypto_generichash(32, masterSeed, new Uint8Array(new TextEncoder().encode("signed-pre-key")));
        
        const encryptionKeyPair = sodium.crypto_box_seed_keypair(encryptionSeed);
        const signingKeyPair = sodium.crypto_sign_seed_keypair(signingSeed);
        const signedPreKeyPair = sodium.crypto_box_seed_keypair(signedPreKeySeed);
        
        try {
          const encryptedPrivateKeys = await storePrivateKeys({
            encryption: encryptionKeyPair.privateKey,
            signing: signingKeyPair.privateKey,
            signedPreKey: signedPreKeyPair.privateKey,
            masterSeed: masterSeed
          }, newPassword);

          // BUAT DIGITAL SIGNATURE
          const messageString = `${identifier}:${timestamp}`;
          const messageBytes = new TextEncoder().encode(messageString);
          const signature = sodium.crypto_sign_detached(messageBytes, signingKeyPair.privateKey);

          result = {
            encryptionPublicKeyB64: exportPublicKey(encryptionKeyPair.publicKey),
            signingPublicKeyB64: exportPublicKey(signingKeyPair.publicKey),
            encryptedPrivateKeys,
            signatureB64: sodium.to_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING)
          };
        } finally {
          sodium.memzero(masterSeed);
          sodium.memzero(encryptionSeed);
          sodium.memzero(signingSeed);
          sodium.memzero(signedPreKeySeed);
          sodium.memzero(encryptionKeyPair.privateKey);
          sodium.memzero(signingKeyPair.privateKey);
          sodium.memzero(signedPreKeyPair.privateKey);
        }
        break;
      }

```

### 2. Update Proxy (`web/src/lib/crypto-worker-proxy.ts`)

*Tambahkan fungsi wrapper public untuk memanggil case di atas:*

```typescript
export async function recoverAccountWithSignature(
  phrase: string, 
  newPassword: string, 
  identifier: string, 
  timestamp: number
): Promise<{
  encryptionPublicKeyB64: string,
  signingPublicKeyB64: string,
  encryptedPrivateKeys: string,
  signatureB64: string
}> {
  return sendToWorker('recoverAccountWithSignature', { phrase, newPassword, identifier, timestamp });
}

```

### 3. Update Backend (`server/src/routes/auth.ts`)

*Tambahkan endpoint baru khusus untuk Recovery. Pastikan kamu import `getSodium` di dalam router jika belum ada, atau gunakan library `sodium-native` / `libsodium-wrappers` yang sudah ada di server.*
*(Letakkan endpoint ini sebelum `export default router`)*

```typescript
// === ZERO-KNOWLEDGE ACCOUNT RECOVERY ===
router.post('/recover', authLimiter, zodValidate({
  body: z.object({
    identifier: z.string().min(1),
    newPassword: z.string().min(8),
    newEncryptedKeys: z.string(),
    signature: z.string(),
    timestamp: z.number()
  })
}), async (req, res, next) => {
  try {
    const { identifier, newPassword, newEncryptedKeys, signature, timestamp } = req.body;

    // 1. Cegah Replay Attack (Maksimal 5 menit)
    const now = Date.now();
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
       throw new ApiError(400, "Recovery request expired.");
    }

    // 2. Cari User
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] }
    });
    if (!user || !user.signingKey) throw new ApiError(404, "User not found or invalid keys.");

    // 3. Verifikasi Signature menggunakan libsdoium
    const { getSodium } = await import('../lib/sodium.js'); // Sesuaikan path import sodium server-mu
    const sodium = await getSodium();
    
    const messageString = `${identifier}:${timestamp}`;
    const messageBytes = Buffer.from(messageString, 'utf-8');
    const signatureBytes = sodium.from_base64(signature, sodium.base64_variants.URLSAFE_NO_PADDING);
    const publicKeyBytes = sodium.from_base64(user.signingKey, sodium.base64_variants.URLSAFE_NO_PADDING);

    const isValid = sodium.crypto_sign_verify_detached(signatureBytes, messageBytes, publicKeyBytes);
    if (!isValid) {
       throw new ApiError(401, "Cryptographic signature verification failed. Invalid phrase.");
    }

    // 4. Update Password dan Keys di Database
    const passwordHash = await hashPassword(newPassword);
    
    // Revoke old sessions
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { 
        passwordHash, 
        encryptedPrivateKey: newEncryptedKeys 
      }
    });

    // 5. Terbitkan Token Baru (Auto Login)
    const tokens = await issueTokens(updatedUser, req);
    setAuthCookies(res, tokens);

    res.json({ message: "Account recovered successfully.", accessToken: tokens.access });
  } catch (e) {
    next(e);
  }
});

```

### 4. Update Frontend UI (`web/src/pages/Restore.tsx`)

*Rombak halaman restore agar meminta identifier (Email/Username), lalu memanggil API endpoint yang baru:*

```tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiKey, FiUpload } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { recoverAccountWithSignature } from '@lib/crypto-worker-proxy';
import { saveEncryptedKeys } from '@lib/keyStorage';
import { useAuthStore } from '@store/auth';
import { api } from '@lib/api';

export default function RestorePage() {
  const [identifier, setIdentifier] = useState('');
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const navigate = useNavigate();

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier || !phrase.trim() || !password) {
      toast.error("Please fill in all fields.");
      return;
    }
    setIsRestoring(true);
    try {
      const trimmedPhrase = phrase.trim().toLowerCase();
      const timestamp = Date.now();
      
      // 1. Generate keys & Sign Payload locally
      const {
        encryptedPrivateKeys,
        signatureB64
      } = await recoverAccountWithSignature(trimmedPhrase, password, identifier, timestamp);

      if (!encryptedPrivateKeys || !signatureB64) {
        throw new Error("Failed to generate recovery payload.");
      }

      // 2. Send Cryptographic Proof to Server
      const res = await api<{ accessToken: string }>('/api/auth/recover', {
        method: 'POST',
        body: JSON.stringify({
          identifier,
          newPassword: password,
          newEncryptedKeys: encryptedPrivateKeys,
          signature: signatureB64,
          timestamp
        })
      });

      // 3. Save to local storage & finalize login
      await saveEncryptedKeys(encryptedPrivateKeys);
      useAuthStore.getState().setHasRestoredKeys(true);
      
      // Force fetch user profile to complete login state
      await useAuthStore.getState().fetchProfile();

      toast.success('Account successfully recovered! Welcome back.');
      navigate('/');

    } catch (error: any) {
      console.error("Restore failed:", error);
      if (error.message?.includes('mnemonic')) {
        toast.error("Invalid recovery phrase. Please check for typos.");
      } else {
        toast.error(error.message || "Recovery failed. Please verify your details.");
      }
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-bg-main text-text-primary p-4 font-mono">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex p-4 rounded-full bg-bg-surface shadow-neumorphic-convex mb-4 text-accent">
             <FiKey size={40} />
          </div>
          <h1 className="text-2xl font-black uppercase tracking-[0.2em] text-text-primary">Account Recovery</h1>
          <p className="text-xs text-text-secondary mt-2 tracking-widest uppercase">
            Zero-Knowledge Password Reset
          </p>
        </div>
        
        <form onSubmit={handleRestore} className="bg-bg-surface p-8 rounded-2xl shadow-neumorphic-convex border border-white/5 relative overflow-hidden">
          <div className="space-y-6">
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">Email or Username</span>
              </label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full p-4 rounded-xl bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="USER_ID..."
                required
              />
            </div>
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">Recovery Phrase</span>
              </label>
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                className="w-full h-24 p-4 rounded-xl resize-none bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="ENTER_12_WORD_SEED_PHRASE..."
                required
              />
            </div>
            <div className="form-control">
              <label className="label mb-2 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary">New Server Password</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-4 rounded-xl bg-bg-main text-text-primary font-mono text-sm shadow-neumorphic-concave focus:outline-none focus:ring-1 focus:ring-accent/50"
                placeholder="SET_NEW_PASSWORD..."
                required
              />
            </div>
          </div>
          <div className="mt-8">
            <button 
              type="submit" 
              className="w-full py-4 rounded-xl font-bold uppercase tracking-wider text-sm bg-accent text-white shadow-neumorphic-convex active:shadow-neumorphic-pressed hover:brightness-110 flex items-center justify-center gap-3" 
              disabled={isRestoring}
            >
              {isRestoring ? <Spinner size="sm" className="text-white" /> : <FiUpload />}
              {isRestoring ? 'VERIFYING...' : 'RECOVER_ACCOUNT'}
            </button>
          </div>
        </form>
        <div className="mt-8 text-center">
          <Link to="/login" className="text-xs font-mono text-text-secondary hover:text-accent uppercase tracking-widest transition-colors">
            [ ABORT_SEQUENCE ]
          </Link>
        </div>
      </div>
    </div>
  );
}

```

*Harap pastikan impor file utilitas sodium di rute backend (`server/src/routes/auth.ts`) menggunakan import path yang benar sesuai struktur kodemu (`import { getSodium } from '../lib/sodium.js';`). Eksekusi keempat poin di atas.*"

