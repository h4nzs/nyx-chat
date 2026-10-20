import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FiCheck, FiLink, FiShield, FiSmartphone, FiX } from 'react-icons/fi';

import { registerAndGenerateKeys } from '@lib/crypto-worker-proxy';
import { saveEncryptedKeys } from '@lib/keyStorage';
import {
  LINK_TOKEN_QUERY_PARAM,
  claimDeviceLink,
  completeDeviceLink,
  getDeviceLinkStatus,
  parseDeviceLinkToken,
} from '@lib/deviceLinking';
import { useAuthStore, getDeviceName } from '@store/auth';

/**
 * [LINK 2026-10-18] Sisi PERANGKAT BARU: `/link?t=<token>`.
 *
 * Alur (server: POST /api/auth/link/*, lihat server/src/routes/auth.ts):
 *   1. Password akun diminta → kunci device BARU dibuat & dienkripsi di sini
 *      (server tidak pernah melihat kunci privat; bundelnya hanya disimpan).
 *   2. `claim` membakar token QR dan menunggu persetujuan perangkat lama.
 *   3. Setelah disetujui, `complete` memberi `{ deviceId, usernameHash }`.
 *   4. Kunci lokal disimpan, lalu `useAuthStore.login()` (jalur login yang sudah
 *      ada) yang membuat sesi — jadi tidak ada jalur sesi kedua.
 *
 * Catatan kebijakan: NYX = satu akun satu device aktif. Begitu login di sini
 * selesai, sesi perangkat lama dicabut oleh server (sama seperti login biasa).
 * Itu sebabnya copy UI menyebutkannya sebelum pengguna memindai.
 */

const POLL_INTERVAL_MS = 2000;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

type Phase = 'form' | 'claiming' | 'waiting' | 'finishing';

export default function LinkDevicePage() {
  const { t } = useTranslation(['auth', 'common']);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = parseDeviceLinkToken(searchParams.get(LINK_TOKEN_QUERY_PARAM));

  const [phase, setPhase] = useState<Phase>('form');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');

  const generatedKeys = useRef<{ encryptedPrivateKeys: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const finishLink = useCallback(async (pendingId: string) => {
    setPhase('finishing');
    const keys = generatedKeys.current;
    if (!keys) throw new Error(t('auth:link.error_generic'));

    // Password ikut dikirim: server memverifikasinya SEBELUM membakar state
    // tautan, sehingga salah ketik password tidak menghabiskan QR.
    const { deviceId, usernameHash } = await completeDeviceLink(pendingId, password);

    // Kunci lokal + deviceId harus tersimpan SEBELUM login: jalur login memakai
    // `alreadyHasKeys` + `deviceId` untuk memperbarui device row yang dibuat saat
    // approve, bukan membuat device kedua.
    localStorage.setItem('deviceId', deviceId);
    await saveEncryptedKeys(keys.encryptedPrivateKeys);

    // Jalur sesi tunggal: verifikasi password + dekripsi kunci + prekey upload
    // semuanya sudah ada di store. Routing setelah ini mengikuti hasRestoredKeys
    // (jangan navigate("/chat") tanpa syarat).
    await useAuthStore.getState().login(usernameHash, password);
  }, [password, t]);

  const waitForApproval = useCallback(async (pendingId: string) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (mounted.current) {
      const state = await getDeviceLinkStatus(pendingId);
      if (!mounted.current) return;
      if (state === 'approved') {
        await finishLink(pendingId);
        if (mounted.current) navigate('/', { replace: true });
        return;
      }
      if (state === 'expired') throw new Error(t('auth:link.error_expired'));
      if (Date.now() > deadline) throw new Error(t('auth:link.error_timeout'));
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }, [finishLink, navigate, t]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    if (!token) {
      setError(t('auth:link.error_missing_token'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('auth:link.error_password_short'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('auth:link.error_password_mismatch'));
      return;
    }

    setPhase('claiming');
    try {
      // Kunci device baru dibuat lokal; `encryptedPrivateKeys` dienkripsi dengan
      // password akun (primitif yang sama dengan register — tidak ada format baru).
      const keys = await registerAndGenerateKeys(password);
      generatedKeys.current = { encryptedPrivateKeys: keys.encryptedPrivateKeys };

      const { pendingId } = await claimDeviceLink({
        token,
        publicKey: keys.encryptionPublicKeyB64,
        pqPublicKey: keys.pqEncryptionPublicKeyB64,
        signingKey: keys.signingPublicKeyB64,
        ...(keys.signingPublicKeyV2B64 ? { signingKeyV2: keys.signingPublicKeyV2B64 } : {}),
        encryptedPrivateKey: keys.encryptedPrivateKeys,
        deviceName: getDeviceName(),
      });

      setPhase('waiting');
      await waitForApproval(pendingId);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error && e.message ? e.message : t('auth:link.error_generic'));
      setPhase('form');
    }
  };

  const busy = phase === 'claiming' || phase === 'waiting' || phase === 'finishing';

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-main p-4">
      <div className="w-full max-w-md bg-bg-surface rounded-2xl p-8 shadow-2xl border border-text-secondary/10">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-lg bg-accent flex items-center justify-center text-white">
            <FiLink size={22} />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight text-text-primary">
              {t('auth:link.title')}
            </h1>
            <p className="text-xs text-text-secondary">{t('auth:link.subtitle')}</p>
          </div>
        </div>

        {!token && (
          <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            {t('auth:link.error_missing_token')}
          </div>
        )}

        {error && (
          <div role="alert" className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-text-secondary mb-1" htmlFor="link-password">
              {t('auth:link.password_label')}
            </label>
            <input
              id="link-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="w-full rounded-xl bg-bg-main border border-text-secondary/10 px-4 py-3 text-text-primary focus:outline-none focus:border-accent disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-text-secondary/80">{t('auth:link.password_hint')}</p>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-text-secondary mb-1" htmlFor="link-password-confirm">
              {t('auth:link.confirm_label')}
            </label>
            <input
              id="link-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
              className="w-full rounded-xl bg-bg-main border border-text-secondary/10 px-4 py-3 text-text-primary focus:outline-none focus:border-accent disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            disabled={busy || !token}
            className="w-full rounded-xl bg-accent px-4 py-3 font-bold text-white shadow-neu-flat dark:shadow-neu-flat-dark transition-all hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {busy ? <FiSmartphone className="animate-pulse" /> : <FiShield />}
            {phase === 'waiting'
              ? t('auth:link.waiting_approval')
              : phase === 'finishing'
                ? t('auth:link.finishing')
                : phase === 'claiming'
                  ? t('auth:link.claiming')
                  : t('auth:link.submit')}
          </button>
        </form>

        {phase === 'waiting' && (
          <div className="mt-5 flex items-start gap-2 rounded-xl bg-bg-main border border-text-secondary/10 p-3 text-xs text-text-secondary">
            <FiCheck className="mt-0.5 shrink-0 text-accent" size={14} />
            {t('auth:link.waiting_hint')}
          </div>
        )}

        <p className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-text-secondary/80">
          <FiX className="mt-0.5 shrink-0" size={12} />
          {t('auth:link.single_device_note')}
        </p>

        <div className="mt-6 text-center">
          <Link to="/login" className="text-sm text-accent hover:underline">
            {t('auth:link.back_to_login')}
          </Link>
        </div>
      </div>
    </div>
  );
}
