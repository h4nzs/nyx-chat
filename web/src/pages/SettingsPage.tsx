import { useState, useRef, ChangeEvent, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { useAuthStore } from '@store/auth';
import { useModalStore } from '@store/modal';
import { useShallow } from 'zustand/react/shallow';
import { toast } from 'react-hot-toast';
import { Spinner } from '../components/Spinner';
import { toAbsoluteUrl } from '@utils/url';
import { usePushNotifications } from '@hooks/usePushNotifications';
import { useThemeStore, ACCENT_COLORS, AccentColor } from '@store/theme';
import { 
  FiChevronRight, FiEdit2, FiHeart, FiCoffee, FiFlag, FiLogOut, 
  FiShield, FiSmartphone, FiKey, FiActivity, FiMoon, FiSun, FiBell, FiHelpCircle, FiArrowLeft, FiLock,
  FiDownload, FiUpload, FiDatabase, FiSend, FiCpu, FiZap, FiAlertTriangle, FiInfo, FiChevronDown
} from 'react-icons/fi';
import { startRegistration } from '@simplewebauthn/browser';
import { IoFingerPrint } from 'react-icons/io5';
import ReportBugModal from '../components/ReportBugModal';
import { api } from '@lib/api';
import { exportDatabaseToJson, importDatabaseFromJson, saveProfileKey } from '@lib/keychainDb';
import { executeLocalWipe } from '@lib/nukeProtocol';
import { useUserProfile } from '@hooks/useUserProfile';
import { useProfileStore } from '@store/profile';
import { generateProfileKey, encryptProfile, minePoW, getRecoveryPhrase } from '@lib/crypto-worker-proxy';
import ModalBase from '../components/ui/ModalBase';
import { useSettingsStore } from '@store/settings';
import { setupBiometricUnlock } from '@lib/biometricUnlock';
import { getDeviceAutoUnlockKey, getEncryptedKeys, setPanicPassword } from '@lib/keyStorage';
import { useMessageStore } from '@store/message';
import ImageCropperModal from '../components/ImageCropperModal';

/* --- MICRO-COMPONENTS --- */

const RockerSwitch = ({ checked, onChange, disabled, label }: { checked: boolean; onChange: () => void; disabled?: boolean; label?: string }) => (
  <button
    type="button"
    onClick={disabled ? undefined : onChange}
    disabled={disabled}
    className={`
      group flex items-center justify-between w-full p-3 rounded-lg transition-all
      hover:bg-accent/5 active:scale-[0.99]
      ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
    `}
    role="switch"
    aria-checked={checked}
  >
    <span className="font-bold text-sm tracking-wide text-text-primary uppercase">{label}</span>
    
    {/* The Track */}
    <div className={`
      w-12 h-6 rounded-full transition-colors duration-300 flex items-center px-1
      shadow-neu-pressed dark:shadow-neu-pressed-dark
      ${checked ? 'bg-accent/10' : 'bg-transparent'}
    `}>
      {/* The Knob */}
      <div className={`
        w-4 h-4 rounded-full shadow-neu-flat dark:shadow-neu-flat-dark bg-bg-main
        transform transition-transform duration-300
        ${checked ? 'translate-x-6 bg-accent' : 'translate-x-0'}
      `} />
    </div>
  </button>
);

const ControlModule = ({ title, children, className = '', icon: Icon }: { title: string; children: React.ReactNode; className?: string; icon?: React.ElementType }) => (
  <div className={`
    relative bg-bg-main rounded-xl p-6 overflow-hidden
    shadow-neu-flat dark:shadow-neu-flat-dark
    border-t border-white/40 dark:border-white/5
    ${className}
  `}>
    {/* VISUAL ANCHORS (The "Rivets") */}
    <div className="absolute top-3 left-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />
    <div className="absolute top-3 right-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />
    <div className="absolute bottom-3 left-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />
    <div className="absolute bottom-3 right-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />

    {/* Header with "Groove" line */}
    <div className="flex items-center gap-4 mb-6 pl-2">
      <div className="p-2 rounded-lg bg-bg-main shadow-neu-icon dark:shadow-neu-icon-dark text-accent">
        {Icon && <Icon size={16} />}
      </div>
      <h3 className="text-xs font-black tracking-[0.2em] uppercase text-text-secondary">{title}</h3>
      <div className="h-[2px] flex-1 bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark rounded-full"></div>
    </div>
    
    <div className="relative z-10 pl-2 pr-2">
      {children}
    </div>
  </div>
);

const ActionButton = ({ onClick, label, icon: Icon, danger = false }: { onClick?: () => void; label: string; icon?: React.ElementType; danger?: boolean }) => (
  <button
    onClick={onClick}
    className={`
      w-full flex items-center justify-between p-4 rounded-xl transition-all duration-200
      bg-bg-main
      shadow-neu-flat dark:shadow-neu-flat-dark
      hover:text-accent active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark active:scale-[0.98]
      ${danger ? 'text-red-500 hover:text-red-600' : 'text-text-primary'}
    `}
  >
    <div className="flex items-center gap-3">
      {Icon && <Icon size={18} />}
      <span className="font-medium text-sm">{label}</span>
    </div>
    <FiChevronRight className="opacity-50" />
  </button>
);

/* --- PAGE COMPONENT --- */

export default function SettingsPage() {
  const navigate = useNavigate();
  // Menambahkan namespace 'auth' agar bisa mengakses label untuk keamanan
  const { t, i18n } = useTranslation(['settings', 'common', 'auth']);
  const { user, updateProfile, updateAvatar, sendReadReceipts, setReadReceipts, logout, emergencyLogout, setUser } = useAuthStore(useShallow(s => ({
    user: s.user, updateProfile: s.updateProfile, updateAvatar: s.updateAvatar, sendReadReceipts: s.sendReadReceipts, setReadReceipts: s.setReadReceipts, logout: s.logout, emergencyLogout: s.emergencyLogout, setUser: s.setUser
  })));
  const profile = useUserProfile(user);
  const { theme, toggleTheme, accent, setAccent } = useThemeStore(useShallow(s => ({
    theme: s.theme, toggleTheme: s.toggleTheme, accent: s.accent, setAccent: s.setAccent
  })));
  const { showConfirm } = useModalStore(useShallow(s => ({ showConfirm: s.showConfirm })));
  const { enableSmartReply, setEnableSmartReply } = useSettingsStore(useShallow(s => ({
    enableSmartReply: s.enableSmartReply, setEnableSmartReply: s.setEnableSmartReply
  })));

  const { 
    isSubscribed, 
    loading: pushLoading, 
    subscribeToPush, 
    unsubscribeFromPush 
  } = usePushNotifications();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [readReceipts, setReadReceiptsState] = useState(sendReadReceipts);
  const [isLoading, setIsLoading] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [miningStatus, setMiningStatus] = useState<'idle' | 'mining' | 'verifying'>('idle');
  const [hasBioVault, setHasBioVault] = useState(false);
  const [panicPass, setPanicPass] = useState('');
  const [avatarCropTarget, setAvatarCropTarget] = useState<{ url: string, file: File } | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const vaultInputRef = useRef<HTMLInputElement>(null);

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deletePassword) return;
    
    setIsDeleting(true);
    try {
        const messagesMap = useMessageStore.getState().messages;
        const fileKeys: string[] = [];
        
        Object.values(messagesMap).flat().forEach((msg: Record<string, unknown>) => {
            if (msg.senderId === user?.id && msg.fileKey) {
                fileKeys.push(msg.fileKey as string);
            }
        });

        await api('/api/users/me', {
            method: 'DELETE',
            body: JSON.stringify({
                password: deletePassword,
                fileKeys
            })
        });

        await executeLocalWipe();
        
        toast.success(t('settings:messages.account_obliterated'));
        window.location.replace('/');
    } catch (error: unknown) {
        setIsDeleting(false);
        const errorMsg = (error as Record<string, unknown>).details ? JSON.parse((error as Record<string, unknown>).details as string).error : (error instanceof Error ? error.message : t('common:errors.unknown'));
        toast.error(t('settings:messages.deletion_failed', { error: errorMsg }));
    }
  };

  const colorMap: Record<AccentColor, string> = {
    blue: 'hsl(217 91% 60%)',
    green: 'hsl(142 76% 42%)',
    purple: 'hsl(262 80% 64%)',
    orange: 'hsl(25 95% 53%)',
    red: 'hsl(0 92% 29%)',
  };

  useEffect(() => {
    if (profile && profile.name !== "Encrypted User" && profile.name !== "Unknown") {
      setName(profile.name || '');
      setDescription(profile.description || '');
      setPreviewUrl(profile.avatarUrl ? toAbsoluteUrl(profile.avatarUrl) || null : null);
    }
  }, [profile]);

  useEffect(() => {
    setReadReceiptsState(sendReadReceipts);
  }, [sendReadReceipts]);

  useEffect(() => {
    const checkBioVault = () => {
        const vault = localStorage.getItem('nyx_bio_vault');
        setHasBioVault(!!vault);
    };
    checkBioVault();
    window.addEventListener('storage', checkBioVault);
    return () => window.removeEventListener('storage', checkBioVault);
  }, []);

  useEffect(() => {
    return () => {
      if (avatarCropTarget?.url) {
        URL.revokeObjectURL(avatarCropTarget.url);
      }
    };
  }, [avatarCropTarget]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarCropTarget({ url: URL.createObjectURL(file), file });
      e.target.value = '';
    }
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      let currentAvatarUrl = profile?.avatarUrl;

      if (avatarFile) {
        currentAvatarUrl = await updateAvatar(avatarFile);
      }
      
      const profileKeyB64 = await import('@lib/keychainDb').then(m => m.getProfileKey(user!.id));
      let key = profileKeyB64;
      if (!key) {
         key = await generateProfileKey();
         await saveProfileKey(user!.id, key);
      }

      const profileJson = JSON.stringify({ name, description, avatarUrl: currentAvatarUrl });
      const encryptedProfile = await encryptProfile(profileJson, key);

      await updateProfile({ encryptedProfile });
      useProfileStore.getState().decryptAndCache(user!.id, encryptedProfile);

      toast.success(t('settings:messages.identity_updated'));
    } catch (error: unknown) {
      const errorMsg = (error as Record<string, unknown>).details ? JSON.parse((error as Record<string, unknown>).details as string).error : (error instanceof Error ? error.message : t('common:errors.unknown'));
      toast.error(t('settings:messages.update_failed', { error: errorMsg }));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegisterPasskey = async () => {
    try {
      let phraseToLock = '';
      
      const autoUnlockKey = await getDeviceAutoUnlockKey();
      const encryptedKeysStr = await getEncryptedKeys();
      
      if (autoUnlockKey && encryptedKeysStr) {
          try {
              phraseToLock = await getRecoveryPhrase(encryptedKeysStr, autoUnlockKey);
          } catch (e) {}
      }

      if (!phraseToLock) {
          await new Promise<void>((resolve, reject) => {
              useModalStore.getState().showPasswordPrompt(async (password) => {
                  if (!password) { reject(new Error("Password required to enable biometric unlock.")); return; }
                  try {
                      const encKeys = await getEncryptedKeys();
                      if (!encKeys) throw new Error("No keys found.");
                      phraseToLock = await getRecoveryPhrase(encKeys, password);
                      resolve();
                  } catch (e) { reject(e); }
              });
          });
      }

      toast.loading(t('settings:messages.biometric_initializing'), { id: 'passkey' });
      const options = await api<unknown>("/api/auth/webauthn/register/options?force=true");
      
      toast.loading(t('settings:messages.biometric_scan_now'), { id: 'passkey' });
      
      const attResp = await setupBiometricUnlock(options as Record<string, unknown>, phraseToLock);
      
      const verificationResp = await api<{ verified: boolean }>("/api/auth/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify(attResp),
      });

      if (verificationResp.verified) {
        toast.success(t('settings:messages.biometric_success'), { id: 'passkey' });
        setShowUpgradeModal(false);
        setHasBioVault(true);
        if (user) setUser({ ...user, isVerified: true });
      } else {
        throw new Error("Verification failed");
      }
    } catch (error: unknown) {
      if ((error as Error).name === 'NotAllowedError') {
        toast.error(t('common:actions.cancel'), { id: 'passkey' });
      } else {
        toast.error(`${t('common:errors.unknown')}`, { id: 'passkey' });
      }
    }
  };

  const handleProofOfWork = async () => {
    setMiningStatus('mining');
    const toastId = toast.loading(t('settings:messages.mining_connecting'));
    
    try {
      const { salt, difficulty } = await api<{ salt: string, difficulty: number }>('/api/auth/pow/challenge');
      
      toast.loading(t('settings:messages.mining_processing'), { id: toastId });
      
      const { nonce } = await minePoW(salt, difficulty);
      
      setMiningStatus('verifying');
      toast.loading(t('settings:messages.mining_verifying'), { id: toastId });
      
      const result = await api<{ success: boolean }>('/api/auth/pow/verify', {
        method: 'POST',
        body: JSON.stringify({ nonce })
      });
      
      if (result.success) {
        toast.success(t('settings:messages.mining_success'), { id: toastId });
        setShowUpgradeModal(false);
        if (user) setUser({ ...user, isVerified: true });
      }
      
    } catch (error: unknown) {
      console.error(error);
      const errorMsg = error instanceof Error ? error.message : t('common:errors.unknown');
      toast.error(t('settings:messages.mining_failed', { error: errorMsg }), { id: toastId });
    } finally {
      setMiningStatus('idle');
    }
  };

  const handleExportVault = async () => {
    try {
      const json = await exportDatabaseToJson();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nyx_vault_backup_${new Date().toISOString().slice(0, 10)}.nyxvault`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t('settings:messages.export_success'));
    } catch (error) {
      console.error("Export failed:", error);
      toast.error(t('settings:messages.export_failed'));
    }
  };

  const handleImportVault = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = event.target?.result as string;
        await importDatabaseFromJson(json);
        toast.success(t('settings:messages.import_success'));
        setTimeout(() => window.location.reload(), 1000);
      } catch (error) {
        console.error("Import failed:", error);
        toast.error(t('settings:messages.import_failed'));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const triggerImport = () => {
    vaultInputRef.current?.click();
  };

  const handleLogout = async () => {
    // Memanggil teks peringatan dari JSON agar dinamis terjemahannya
    showConfirm(
      t('settings:emergency.eject'),
      t('settings:emergency.delete_desc'),
      async () => {
        const toastId = toast.loading(t('settings:messages.emergency_revoking'));
        try {
          const { api } = await import('@lib/api');
          try {
            await api('/api/sessions', { method: 'DELETE' }); 
          } catch (e) {
            console.warn("Failed to clear secondary sessions, proceeding to current session logout.");
          }
          await api('/api/auth/logout', { method: 'POST' }); 
          
          toast.success(t('settings:messages.emergency_success'), { id: toastId });
          await executeLocalWipe();
        } catch (error: unknown) {
          console.error("Emergency eject API failed:", error);
          toast.error(t('settings:messages.emergency_failed'), { id: toastId });
        }
      }
    );
  };

  if (!user) return <div className="h-screen w-full flex items-center justify-center bg-bg-main"><Spinner /></div>;

  return (
    <div className="w-full bg-bg-main text-text-primary p-4 md:p-8 font-sans selection:bg-accent selection:text-white pb-32">
      
      {/* HEADER */}
      <header className="max-w-7xl mx-auto mb-10 flex items-center gap-6">
        <Link 
          to="/chat" 
          className="
            p-4 rounded-full bg-bg-main text-text-primary
            shadow-neu-flat-light dark:shadow-neu-flat-dark
            active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
            transition-all hover:text-accent
          "
        >
          <FiArrowLeft size={24} />
        </Link>
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tighter opacity-90">{t('settings:header.control_deck')}</h1>
          <p className="text-sm font-mono text-text-secondary tracking-widest uppercase">{t('settings:header.system_version', { version: __APP_VERSION__ })} </p>
        </div>
      </header>

      {/* BENTO GRID LAYOUT */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-4">
        
        {/* 1. IDENTITY SLOT (Profile) */}
        <div className="col-span-1 md:col-span-12 lg:col-span-8">
          <form onSubmit={handleProfileSubmit} className="h-full">
            <ControlModule title={t('settings:modules.identity')} className="h-full relative group">
              <div className="flex flex-col md:flex-row items-center gap-8">
                {/* Avatar Slot - Concave Recess */}
                <div className="relative flex-shrink-0">
                  <div className="
                    w-40 h-40 rounded-full
                    shadow-neu-pressed-light dark:shadow-neu-pressed-dark
                    flex items-center justify-center
                    bg-bg-main p-2
                  ">
                    <img
                      src={previewUrl || `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(user?.id || 'anonymous')}`}
                      alt="ID"
                      className="w-full h-full rounded-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="
                      absolute bottom-2 right-2 p-3 rounded-full 
                      bg-accent text-white 
                      shadow-lg hover:scale-110 transition-transform
                    "
                  >
                    <FiEdit2 size={18} />
                  </button>
                  <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
                </div>

                {/* Info Fields */}
                <div className="flex-1 w-full space-y-6">
                  {/* ID (Read Only) */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                       <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2">{t('settings:identity.anonymous_id')}</label>
                       {user.isVerified ? (
                         <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-1">
                           <FiShield size={10} /> {t('settings:identity.verified')}
                         </span>
                       ) : (
                         <button 
                           type="button"
                           onClick={() => setShowUpgradeModal(true)}
                           className="text-[10px] bg-yellow-500/10 text-yellow-500 px-2 py-0.5 rounded font-bold uppercase tracking-wider flex items-center gap-1 hover:bg-yellow-500/20 transition-colors animate-pulse"
                         >
                           <FiLock size={10} /> {t('settings:identity.sandboxed')}
                         </button>
                       )}
                    </div>
                    <div className="w-full bg-black/5 dark:bg-white/5 text-sm font-mono text-text-primary p-4 rounded-xl flex items-center border border-transparent">
                      <span className="text-accent mr-1">#</span>{user.id}
                      <FiLock className="ml-auto text-text-secondary opacity-50" size={12} />
                    </div>
                    {!user.isVerified && (
                        <p className="text-[10px] text-text-secondary pl-2">
                           {t('settings:identity.limited_access')}
                        </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2">{t('settings:identity.display_name')}</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="
                        w-full bg-transparent text-xl font-bold tracking-tight text-text-primary
                        p-4 rounded-xl outline-none transition-all
                        shadow-neu-pressed-light dark:shadow-neu-pressed-dark
                        focus:ring-2 focus:ring-accent/50
                      "
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2">{t('settings:identity.bio')}</label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={2}
                      maxLength={150}
                      className="
                        w-full bg-transparent text-sm font-mono text-text-secondary
                        p-4 rounded-xl outline-none resize-none transition-all
                        shadow-neu-pressed-light dark:shadow-neu-pressed-dark
                        focus:ring-2 focus:ring-accent/50
                      "
                    />
                  </div>
                </div>
              </div>
              
              <div className="mt-8 flex justify-end">
                <button 
                  type="submit" 
                  disabled={isLoading}
                  className="
                    px-8 py-3 rounded-xl font-bold uppercase tracking-wider text-sm
                    text-accent bg-bg-main
                    shadow-neu-flat-light dark:shadow-neu-flat-dark
                    active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                    hover:text-white hover:bg-accent transition-all
                  "
                >
                  {isLoading ? t('settings:identity.processing') : t('settings:identity.save_btn')}
                </button>
              </div>
            </ControlModule>
          </form>
        </div>

        {/* 2. POWER CELL (Donation) */}
        <div className="col-span-1 md:col-span-6 lg:col-span-4 flex flex-col">
          <a 
            href="https://sociabuzz.com/h4nzs/tribe" 
            target="_blank" 
            rel="noopener noreferrer"
            className="flex-1 group relative overflow-hidden rounded-3xl bg-bg-main shadow-neu-flat-light dark:shadow-neu-flat-dark border border-accent/20 transition-all hover:scale-[1.02]"
          >
            {/* Battery Level Indicator */}
            <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent opacity-50"></div>
            <div className="absolute top-0 right-0 p-4 opacity-20 group-hover:opacity-100 transition-opacity">
              <FiActivity size={40} className="text-accent animate-pulse" />
            </div>

            <div className="relative z-10 p-8 h-full flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 mb-2 text-accent">
                  <FiCoffee size={24} />
                  <span className="font-black tracking-widest uppercase text-xs">{t('settings:modules.power')}</span>
                </div>
                <h3 className="text-2xl font-bold leading-tight mb-2 whitespace-pre-line">{t('settings:power.refuel_title')}</h3>
                <p className="text-xs text-text-secondary font-mono leading-relaxed">
                  {t('settings:power.description')}
                </p>
              </div>
              <div className="mt-6 flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold tracking-widest text-text-secondary/50">{t('settings:power.status')}</span>
                <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center text-accent shadow-[0_0_15px_rgba(var(--accent),0.4)]">
                   <FiHeart className="fill-current" />
                </div>
              </div>
            </div>
            
            {/* Glowing Bottom Bar */}
            <div className="absolute bottom-0 left-0 w-full h-1 bg-accent shadow-[0_-2px_10px_rgba(var(--accent),1)]"></div>
          </a>
        </div>

        {/* 3. VISUAL INTERFACE (Theme) */}
        <div className="col-span-1 md:col-span-6 lg:col-span-4">
          <ControlModule title={t('settings:modules.visual')} icon={theme === 'dark' ? FiMoon : FiSun}>
            <div className="space-y-6">
              <RockerSwitch 
                label={t('settings:visual.dark_mode')} 
                checked={theme === 'dark'} 
                onChange={toggleTheme} 
              />
              
              <div className="space-y-3 pt-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-1">{t('settings:visual.accent_emitter')}</span>
                <div className="grid grid-cols-4 gap-4 p-2 rounded-2xl shadow-neu-pressed-light dark:shadow-neu-pressed-dark bg-bg-main">
                  {ACCENT_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setAccent(color)}
                      style={{ backgroundColor: colorMap[color] }}
                      className={`
                        h-10 w-full rounded-lg transition-all duration-300 relative
                        ${accent === color ? 'scale-90 shadow-inner brightness-110' : 'shadow-md hover:scale-105'}
                      `}
                    >
                      {accent === color && (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <div className="w-2 h-2 bg-white rounded-full shadow-lg animate-pulse" />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Language Switcher */}
              <div className="space-y-3 pt-4 border-t border-white/5 mt-4">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-1">
                  Language / Bahasa
                </span>
                <div className="relative">
                  <select
                    value={i18n.language}
                    onChange={(e) => i18n.changeLanguage(e.target.value)}
                    className="
                      w-full appearance-none bg-bg-main text-text-primary text-sm font-bold
                      p-3 rounded-xl outline-none transition-all
                      shadow-neu-pressed-light dark:shadow-neu-pressed-dark
                      focus:ring-2 focus:ring-accent/50 cursor-pointer pl-4
                    "
                  >
                    <option value="en">🇺🇸 English</option>
                    <option value="id">🇮🇩 Indonesia</option>
                  </select>
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-text-secondary">
                    <FiChevronDown />
                  </div>
                </div>
              </div>
            </div>
          </ControlModule>
        </div>

        {/* 4. PRIVACY SHIELD (Privacy) */}
        <div className="col-span-1 md:col-span-6 lg:col-span-4">
          <ControlModule title={t('settings:modules.privacy')} icon={FiShield}>
            <div className="space-y-4">
              <RockerSwitch 
                label={t('settings:privacy.read_receipts')} 
                checked={readReceipts} 
                onChange={() => {
                  setReadReceiptsState(!readReceipts);
                  setReadReceipts(!readReceipts);
                }} 
              />
              <button
                onClick={handleRegisterPasskey}
                className={`
                  mt-4 w-full p-4 rounded-xl flex items-center justify-between
                  bg-bg-main text-text-primary
                  shadow-neu-flat-light dark:shadow-neu-flat-dark
                  active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                  hover:text-accent transition-colors
                `}
              >
                <div className="flex items-center gap-3">
                  <IoFingerPrint size={20} />
                  <div className="text-left">
                    <div className="font-bold text-sm">
                        {hasBioVault ? t('settings:privacy.biometric_active') : (user.isVerified ? t('settings:privacy.biometric_enable') : t('settings:privacy.biometric_enable'))}
                    </div>
                    <div className="text-[10px] text-text-secondary">{t('auth:buttons.verify_identity')}</div>
                  </div>
                </div>
                <div className={`w-2 h-2 rounded-full shadow-[0_0_5px] ${hasBioVault ? 'bg-green-500 shadow-green-500' : 'bg-gray-500 shadow-transparent'}`}></div>
              </button>

            {/* PANIC PASSWORD */}
            <div className="pt-4 border-t border-white/5 space-y-3 mt-4">
              <div>
                <h4 className="text-sm font-bold text-text-primary flex items-center gap-2">
                  <FiShield className="text-red-500" /> {t('settings:privacy.panic_password')}
                </h4>
                <p className="text-xs text-text-secondary mt-1">
                  {t('settings:privacy.panic_desc')}
                </p>
              </div>
              <div className="flex gap-2">
                 <input 
                   type="password" 
                   value={panicPass} 
                   onChange={e => setPanicPass(e.target.value)} 
                   placeholder={t('auth:fields.password')} 
                   className="bg-bg-main border border-white/10 rounded-lg px-4 py-2 text-sm text-text-primary focus:ring-red-500/50 flex-1 outline-none" 
                 />
                 <button 
                   type="button"
                   onClick={async () => { 
                     await setPanicPassword(panicPass); 
                     toast.success(t('common:actions.saved')); 
                     setPanicPass(''); 
                   }} 
                   className="px-4 py-2 bg-red-500/20 text-red-500 rounded-lg text-sm font-bold hover:bg-red-500 hover:text-white transition-colors"
                 >
                   {t('common:actions.save')}
                 </button>
              </div>
            </div>

            {/* DEAD MAN'S SWITCH */}
            <div className="pt-4 border-t border-white/5 space-y-3 mt-4">
             <div>
               <h4 className="text-sm font-bold text-text-primary flex items-center gap-2">
                 <span className="text-red-500"><FiAlertTriangle size={18} /></span> {t('settings:privacy.dead_man')}
               </h4>
               <p className="text-xs text-text-secondary mt-1">
                 {t('settings:privacy.dead_man_desc')}
               </p>
             </div>
             <div className="flex gap-2 items-center">
                <select
                  value={user?.autoDestructDays || ''}
                  onChange={async (e) => {
                    const val = e.target.value;                     
                    const days = val === '' ? null : parseInt(val, 10);
                     try {
                        const { api } = await import('@lib/api');
                        await api('/api/users/me', { method: 'PUT', body: JSON.stringify({ autoDestructDays: days }) });
                        useAuthStore.getState().bootstrap(true);
                        toast.success(t('common:actions.saved'));
                     } catch (err) { toast.error(t('common:errors.network')); }
                   }}
                   className="bg-bg-main border border-white/10 rounded-lg px-4 py-2 text-sm text-text-primary focus:ring-accent flex-1 outline-none"
                 >
                   <option value="">{t('settings:privacy.auto_destruct_options.disabled')}</option>
                   <option value="7">{t('settings:privacy.auto_destruct_options.7_days')}</option>
                   <option value="14">{t('settings:privacy.auto_destruct_options.14_days')}</option>
                   <option value="30">{t('settings:privacy.auto_destruct_options.30_days')}</option>
                 </select>
              </div>
            </div>
            </div>
          </ControlModule>
        </div>

        {/* 5. DATA PORT (Sessions & Keys) */}
        <div className="col-span-1 md:col-span-6 lg:col-span-4">
          <ControlModule title={t('settings:modules.data')} icon={FiKey}>
            <div className="space-y-3">
              <ActionButton 
                label={t('settings:data.keys')} 
                icon={FiKey} 
                onClick={() => navigate('/settings/keys')} 
              />
              <ActionButton 
                label={t('settings:data.sessions')} 
                icon={FiSmartphone} 
                onClick={() => navigate('/settings/sessions')} 
              />
              
              {/* VAULT ACTIONS */}
              <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-text-secondary/10">
                 <button 
                   onClick={handleExportVault}
                   className="
                     flex flex-col items-center justify-center gap-2 p-3 rounded-xl
                     bg-bg-main text-emerald-500 font-bold text-xs uppercase tracking-wider
                     shadow-neu-flat-light dark:shadow-neu-flat-dark
                     active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                     hover:brightness-110 transition-all
                   "
                 >
                   <FiDownload size={18} />
                   {t('settings:data.export_vault')}
                 </button>
                 <button 
                   onClick={triggerImport}
                   className="
                     flex flex-col items-center justify-center gap-2 p-3 rounded-xl
                     bg-bg-main text-blue-500 font-bold text-xs uppercase tracking-wider
                     shadow-neu-flat-light dark:shadow-neu-flat-dark
                     active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                     hover:brightness-110 transition-all
                   "
                 >
                   <FiUpload size={18} />
                   {t('settings:data.import_vault')}
                 </button>
                 <button 
                   onClick={() => navigate('/settings/migrate-send')}
                   className="
                     col-span-2 flex items-center justify-center gap-2 p-3 rounded-xl
                     bg-bg-main text-accent font-bold text-xs uppercase tracking-wider
                     shadow-neu-flat-light dark:shadow-neu-flat-dark
                     active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                     hover:brightness-110 transition-all
                   "
                 >
                   <FiSend size={18} />
                   {t('settings:data.transfer')}
                 </button>
                 <input 
                    type="file" 
                    ref={vaultInputRef} 
                    onChange={handleImportVault} 
                    accept=".nyxvault,.json" 
                    className="hidden" 
                 />
              </div>
            </div>
          </ControlModule>
        </div>

        {/* 6. SMART ASSISTANCE */}
        <div className="col-span-1 md:col-span-6 lg:col-span-4">
          <ControlModule title={t('settings:modules.smart')} icon={FiActivity}>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-text-primary">{t('settings:smart.ai_reply')}</h3>
                  <p className="text-[10px] text-text-secondary mt-0.5">{t('settings:smart.ai_desc')}</p>
                </div>
                <RockerSwitch
                  checked={enableSmartReply}
                  onChange={() => setEnableSmartReply(!enableSmartReply)}
                />
                </div>

                {enableSmartReply && (
                <div className="p-3 bg-accent/5 border border-accent/10 rounded-lg">
                  <p className="text-[10px] text-text-secondary leading-relaxed">
                    <strong className="text-accent">{t('settings:smart.privacy_note')}</strong> <Trans i18nKey="settings:smart.privacy_desc">Incoming messages are decrypted on-device and sent securely to Google Gemini for analysis. Messages are <strong className="text-text-primary">not stored</strong> by our servers.</Trans>
                  </p>
                </div>
                )}
                </div>
                </ControlModule>
                </div>

                {/* 7. SUPPORT MODULE */}
                <div className="col-span-1 md:col-span-12 lg:col-span-12">
                <ControlModule title={t('settings:modules.support')} className="flex flex-col md:flex-row gap-6">
                <div className="flex-1 space-y-4">
                <RockerSwitch
                  label={t('settings:support.push_notif')}
                  checked={isSubscribed}
                  onChange={isSubscribed ? unsubscribeFromPush : subscribeToPush}
                  disabled={pushLoading}
                />

                {/* Background Execution Guide - Only show if push is enabled */}
                {isSubscribed && (
                  <div className="mt-3 p-4 bg-accent/10 border border-accent/20 rounded-2xl flex items-start gap-3 transition-all animate-in fade-in slide-in-from-top-2">
                    <FiInfo className="text-accent shrink-0 mt-0.5" size={20} />
                    <div className="text-sm text-text-secondary leading-relaxed">
                      <p className="text-accent font-bold mb-1">{t('settings:support.background_guide')}</p>
                      <p className="mb-2">
                        {t('settings:support.background_desc')}
                      </p>
                      <div className="bg-black/20 p-3 rounded-xl border border-white/5 space-y-2 text-xs">
                        <p>
                          <Trans i18nKey="settings:support.android_guide_steps">
                            <strong className="text-text-primary">🤖 Android:</strong> Settings {'>'} Apps {'>'} NYX (Chrome/any Browser you use if you are not installing nyx into home screen) {'>'} Battery {'>'} <span className="text-emerald-400">Unrestricted</span>
                          </Trans>
                        </p>
                        <p>
                          <Trans i18nKey="settings:support.ios_guide_steps">
                            <strong className="text-text-primary">🍎 iOS:</strong> Settings {'>'} NYX (or Safari/Chrome) {'>'} <span className="text-emerald-400">Enable Background App Refresh</span>
                          </Trans>
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                </div>             
             <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                <ActionButton label={t('settings:support.help_center')} icon={FiHelpCircle} onClick={() => navigate('/help')} />
                <ActionButton label={t('settings:support.report_bug')} icon={FiFlag} onClick={() => setShowReportModal(true)} />
                <ActionButton label={t('settings:support.legal')} icon={FiShield} onClick={() => navigate('/privacy')} />
             </div>
          </ControlModule>
        </div>

        {/* 8. EMERGENCY EJECT (Logout) */}
        <div className="col-span-1 md:col-span-12 mt-8 mb-10 space-y-4">
          <button
            onClick={handleLogout}
            className="
              group w-full relative overflow-hidden rounded-xl p-6
              bg-bg-main border-2 border-orange-500/20
              shadow-neu-flat-light dark:shadow-neu-flat-dark
              active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark active:scale-[0.99]
              transition-all duration-200
            "
          >
            {/* Warning Stripes Pattern */}
            <div className="absolute inset-0 opacity-5 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,rgba(249,115,22,0.05)_10px,rgba(249,115,22,0.05)_20px)]"></div>
            
            <div className="relative z-10 flex flex-col items-center justify-center gap-2 text-orange-500 group-hover:text-orange-600">
              <FiLogOut size={32} />
              <span className="text-xl font-black uppercase tracking-[0.2em]">{t('settings:emergency.eject')}</span>
              <span className="text-xs font-mono opacity-70">{t('settings:emergency.terminate_sessions')}</span>
            </div>
          </button>

          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="
              group w-full relative overflow-hidden rounded-xl p-6
              bg-red-950/10 border-2 border-red-600/30
              hover:bg-red-950/20 hover:border-red-600/50
              active:scale-[0.99]
              transition-all duration-200
            "
          >
            <div className="relative z-10 flex flex-col items-center justify-center gap-2 text-red-600">
              <div className="p-3 bg-red-600 text-white rounded-full mb-1">
                 <FiAlertTriangle size={24} />
              </div>
              <span className="text-xl font-black uppercase tracking-[0.2em]">{t('settings:emergency.delete_account')}</span>
              <span className="text-xs font-mono opacity-70 text-center max-w-md">
                {t('settings:emergency.delete_desc')}
              </span>
            </div>
          </button>
        </div>

      </div>

      {/* UPGRADE MODAL */}
      <ModalBase isOpen={showUpgradeModal} onClose={() => setShowUpgradeModal(false)} title={t('settings:modals.upgrade_title')}>
        <div className="space-y-6">
           <p className="text-sm text-text-secondary text-center">
             <Trans i18nKey="settings:modals.sandbox_mode">
               You are currently in <span className="text-yellow-500 font-bold">Sandbox Mode</span>. 
               Upgrade to remove messaging limits and unlock group creation.
             </Trans>
           </p>
           
           <div className="grid grid-cols-1 gap-4">
             {/* Option 1: Biometric */}
             <button
               onClick={handleRegisterPasskey}
               className="p-4 bg-bg-surface rounded-xl border border-white/5 shadow-neu-flat hover:border-accent/50 transition-all text-left flex items-start gap-4 group"
             >
               <div className="p-3 bg-accent/10 text-accent rounded-full group-hover:bg-accent group-hover:text-white transition-colors">
                 <FiZap size={24} />
               </div>
               <div>
                 <h3 className="font-bold text-text-primary">{t('settings:modals.instant_biometric')}</h3>
                 <p className="text-xs text-text-secondary mt-1">{t('settings:modals.biometric_desc')}</p>
               </div>
             </button>

             {/* Option 2: Proof of Work */}
             <button
               onClick={handleProofOfWork}
               disabled={miningStatus !== 'idle'}
               className="p-4 bg-bg-surface rounded-xl border border-white/5 shadow-neu-flat hover:border-accent/50 transition-all text-left flex items-start gap-4 group disabled:opacity-50 disabled:cursor-not-allowed"
             >
               <div className="p-3 bg-blue-500/10 text-blue-500 rounded-full group-hover:bg-blue-500 group-hover:text-white transition-colors">
                 {miningStatus === 'idle' ? <FiCpu size={24} /> : <Spinner size="sm" />}
               </div>
               <div>
                 <h3 className="font-bold text-text-primary">{t('settings:modals.pow_mining')}</h3>
                 <p className="text-xs text-text-secondary mt-1">
                   {miningStatus === 'idle' ? t('settings:modals.pow_idle') : 
                    miningStatus === 'mining' ? t('settings:modals.pow_mining_status') : t('settings:modals.pow_verifying')}
                 </p>
               </div>
             </button>
           </div>
        </div>
      </ModalBase>

      {/* DELETE ACCOUNT MODAL */}
      <ModalBase isOpen={showDeleteConfirm} onClose={() => { setShowDeleteConfirm(false); setDeletePassword(''); }} title={t('settings:modals.delete_confirm_title')}>
        <form onSubmit={handleDeleteAccount} className="space-y-6">
            <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-xl flex items-start gap-3">
                <FiAlertTriangle className="text-red-500 shrink-0 mt-1" />
                <div className="space-y-2">
                    <h4 className="text-red-500 font-bold text-sm">{t('settings:modals.final_warning')}</h4>
                    <p className="text-xs text-text-secondary leading-relaxed">
                        {t('settings:emergency.delete_desc')}
                    </p>
                </div>
            </div>

            <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2">
                    {t('settings:modals.confirm_password')}
                </label>
                <input
                    type="password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    placeholder={t('auth:fields.password')}
                    className="
                        w-full bg-bg-main text-text-primary p-4 rounded-xl outline-none
                        border border-red-500/30 focus:border-red-500
                        shadow-neu-pressed-light dark:shadow-neu-pressed-dark
                    "
                    autoFocus
                />
            </div>

            <div className="flex gap-3 pt-2">
                <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="flex-1 py-3 rounded-xl font-bold text-sm text-text-secondary hover:bg-bg-surface transition-colors"
                >
                    {t('settings:modals.abort')}
                </button>
                <button
                    type="submit"
                    disabled={!deletePassword || isDeleting}
                    className="
                        flex-1 py-3 rounded-xl font-bold text-sm text-white
                        bg-red-600 hover:bg-red-700
                        disabled:opacity-50 disabled:cursor-not-allowed
                        shadow-lg shadow-red-600/20
                    "
                >
                    {isDeleting ? t('settings:identity.processing') : t('settings:modals.execute_delete')}
                </button>
            </div>
        </form>
      </ModalBase>

      {/* MODALS */}
      {showReportModal && <ReportBugModal onClose={() => setShowReportModal(false)} />}
      
      {avatarCropTarget && (
        <ImageCropperModal
          file={avatarCropTarget.file}
          url={avatarCropTarget.url}
          aspect={1} // Force square for avatars
          onClose={() => setAvatarCropTarget(null)}
          onSave={(croppedFile) => {
            setAvatarFile(croppedFile);
            setPreviewUrl(URL.createObjectURL(croppedFile));
            setAvatarCropTarget(null);
          }}
        />
      )}
    </div>
  );
}
