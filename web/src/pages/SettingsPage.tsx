import { useState, useRef, ChangeEvent, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@store/auth';
import { useModalStore } from '@store/modal';
import { toast } from 'react-hot-toast';
import { Spinner } from '../components/Spinner';
import { toAbsoluteUrl } from '@utils/url';
import { usePushNotifications } from '@hooks/usePushNotifications';
import { useThemeStore, ACCENT_COLORS, AccentColor } from '@store/theme';
import { 
  FiChevronRight, FiEdit2, FiHeart, FiCoffee, FiFlag, FiLogOut, 
  FiShield, FiSmartphone, FiKey, FiActivity, FiMoon, FiSun, FiBell, FiHelpCircle, FiArrowLeft, FiLock,
  FiDownload, FiUpload, FiDatabase, FiSend
} from 'react-icons/fi';
import { startRegistration } from '@simplewebauthn/browser';
import { IoFingerPrint } from 'react-icons/io5';
import ReportBugModal from '../components/ReportBugModal';
import { api } from '@lib/api';
import { exportDatabaseToJson, importDatabaseFromJson } from '@lib/keychainDb';

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

const ControlModule = ({ title, children, className = '', icon: Icon }: { title: string; children: React.ReactNode; className?: string; icon?: any }) => (
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

const ActionButton = ({ onClick, label, icon: Icon, danger = false }: { onClick?: () => void; label: string; icon?: any; danger?: boolean }) => (
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

import { useSettingsStore } from '@store/settings';

/* --- PAGE COMPONENT --- */

export default function SettingsPage() {
  const navigate = useNavigate();
  const { user, updateProfile, updateAvatar, sendReadReceipts, setReadReceipts, logout } = useAuthStore();
  const { theme, toggleTheme, accent, setAccent } = useThemeStore();
  const { showConfirm } = useModalStore();
  const { enableSmartReply, setEnableSmartReply } = useSettingsStore();

  const { 
    isSubscribed, 
    loading: pushLoading, 
    subscribeToPush, 
    unsubscribeFromPush 
  } = usePushNotifications();

  const [name, setName] = useState(user?.name || '');
  const [description, setDescription] = useState(user?.description || '');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(user?.avatarUrl ? toAbsoluteUrl(user.avatarUrl) || null : null);
  const [readReceipts, setReadReceiptsState] = useState(sendReadReceipts);
  const [isLoading, setIsLoading] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const vaultInputRef = useRef<HTMLInputElement>(null);

  const colorMap: Record<AccentColor, string> = {
    blue: 'hsl(217 91% 60%)',
    green: 'hsl(142 76% 42%)',
    purple: 'hsl(262 80% 64%)',
    orange: 'hsl(25 95% 53%)',
    red: 'hsl(0 92% 29%)',
  };

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setDescription(user.description || '');
      setPreviewUrl(user.avatarUrl ? toAbsoluteUrl(user.avatarUrl) || null : null);
      setReadReceiptsState(sendReadReceipts);
    }
  }, [user, sendReadReceipts]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const promises = [];
      if (avatarFile) {
        promises.push(updateAvatar(avatarFile));
      }
      if (name !== user?.name || description !== user?.description) {
        promises.push(updateProfile({ name, description }));
      }
      if (promises.length === 0) {
        toast('No changes detected.');
        return;
      }
      await Promise.all(promises);
      toast.success('Identity Updated');
    } catch (error: any) {
      const errorMsg = error.details ? JSON.parse(error.details).error : error.message;
      toast.error(`Update failed: ${errorMsg}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegisterPasskey = async () => {
    try {
      toast.loading("Initializing biometric scanner...", { id: 'passkey' });
      const options = await api<any>("/api/auth/webauthn/register/options");
      
      toast.loading("Scan fingerprint now...", { id: 'passkey' });
      const attResp = await startRegistration(options);
      
      const verificationResp = await api<{ verified: boolean }>("/api/auth/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify(attResp),
      });

      if (verificationResp.verified) {
        toast.success("Biometric signature confirmed.", { id: 'passkey' });
      } else {
        throw new Error("Verification failed");
      }
    } catch (error: any) {
      if (error.name === 'NotAllowedError') {
        toast.error("Scan cancelled.", { id: 'passkey' });
      } else {
        toast.error(`Error: ${error.message}`, { id: 'passkey' });
      }
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
      toast.success("Vault exported successfully! Keep this file safe.");
    } catch (error) {
      console.error("Export failed:", error);
      toast.error("Failed to export vault.");
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
        toast.success("Vault imported successfully! Reloading...");
        setTimeout(() => window.location.reload(), 1000);
      } catch (error) {
        console.error("Import failed:", error);
        toast.error("Invalid vault file or corrupted data.");
      }
    };
    reader.readAsText(file);
    // Reset input value so same file can be selected again
    e.target.value = '';
  };

  const triggerImport = () => {
    vaultInputRef.current?.click();
  };


  const handleLogout = async () => {
    showConfirm(
      "Emergency Eject",
      "WARNING: You are about to terminate all active sessions. Proceed?",
      async () => {
        await logout();
        navigate('/login');
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
          <h1 className="text-4xl font-black uppercase tracking-tighter opacity-90">Control Deck</h1>
          <p className="text-sm font-mono text-text-secondary tracking-widest uppercase">System Configuration v2.0</p>
        </div>
      </header>

      {/* BENTO GRID LAYOUT */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-12 gap-4">
        
        {/* 1. IDENTITY SLOT (Profile) */}
        <div className="col-span-1 md:col-span-12 lg:col-span-8">
          <form onSubmit={handleProfileSubmit} className="h-full">
            <ControlModule title="Identity Module" className="h-full relative group">
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
                      src={previewUrl || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`}
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
                    <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2">ANONYMOUS ID</label>
                    <div className="w-full bg-black/5 dark:bg-white/5 text-sm font-mono text-text-primary p-4 rounded-xl flex items-center border border-transparent">
                      <span className="text-accent mr-1">#</span>{user.id}
                      <FiLock className="ml-auto text-text-secondary opacity-50" size={12} />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2">Display Name</label>
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
                    <label className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-2">Bio-Data</label>
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
                  {isLoading ? 'Processing...' : 'Save Identity'}
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
                  <span className="font-black tracking-widest uppercase text-xs">Power Cell</span>
                </div>
                <h3 className="text-2xl font-bold leading-tight mb-2">Refuel the <br/> Developer</h3>
                <p className="text-xs text-text-secondary font-mono leading-relaxed">
                  System operates on low-cost servers. Initiate donation sequence to upgrade infrastructure.
                </p>
              </div>
              <div className="mt-6 flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold tracking-widest text-text-secondary/50">Status: Need Coffee</span>
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
          <ControlModule title="Visual Interface" icon={theme === 'dark' ? FiMoon : FiSun}>
            <div className="space-y-6">
              <RockerSwitch 
                label="Dark Mode" 
                checked={theme === 'dark'} 
                onChange={toggleTheme} 
              />
              
              <div className="space-y-3 pt-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-secondary pl-1">Accent Emitter</span>
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
            </div>
          </ControlModule>
        </div>

        {/* 4. PRIVACY SHIELD (Privacy) */}
        <div className="col-span-1 md:col-span-6 lg:col-span-4">
          <ControlModule title="Privacy Shield" icon={FiShield}>
            <div className="space-y-4">
              <RockerSwitch 
                label="Read Receipts" 
                checked={readReceipts} 
                onChange={() => {
                  setReadReceiptsState(!readReceipts);
                  setReadReceipts(!readReceipts);
                }} 
              />
              <button
                onClick={handleRegisterPasskey}
                className="
                  mt-4 w-full p-4 rounded-xl flex items-center justify-between
                  bg-bg-main text-text-primary
                  shadow-neu-flat-light dark:shadow-neu-flat-dark
                  active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
                  hover:text-accent transition-colors
                "
              >
                <div className="flex items-center gap-3">
                  <IoFingerPrint size={20} />
                  <div className="text-left">
                    <div className="font-bold text-sm">Biometric Key</div>
                    <div className="text-[10px] text-text-secondary">Fingerprint / Face ID</div>
                  </div>
                </div>
                <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_5px_#22c55e]"></div>
              </button>
            </div>
          </ControlModule>
        </div>

        {/* 5. DATA PORT (Sessions & Keys) */}
        <div className="col-span-1 md:col-span-6 lg:col-span-4">
          <ControlModule title="Data Ports" icon={FiKey}>
            <div className="space-y-3">
              <ActionButton 
                label="Encryption Keys" 
                icon={FiKey} 
                onClick={() => navigate('/settings/keys')} 
              />
              <ActionButton 
                label="Active Sessions" 
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
                   Export Vault
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
                   Import Vault
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
                   Transfer to New Device (QR)
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
          <ControlModule title="Smart Assistance" icon={FiActivity}>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-text-primary">AI Smart Reply</h3>
                  <p className="text-[10px] text-text-secondary mt-0.5">Auto-generate response suggestions.</p>
                </div>
                <RockerSwitch 
                  checked={enableSmartReply} 
                  onChange={() => setEnableSmartReply(!enableSmartReply)} 
                />
              </div>
              
              {enableSmartReply && (
                <div className="p-3 bg-accent/5 border border-accent/10 rounded-lg">
                  <p className="text-[10px] text-text-secondary leading-relaxed">
                    <strong className="text-accent">Privacy Note:</strong> Incoming messages are decrypted on-device and sent securely to Google Gemini for analysis. Messages are <strong className="text-text-primary">not stored</strong> by our servers.
                  </p>
                </div>
              )}
            </div>
          </ControlModule>
        </div>

        {/* 7. SUPPORT MODULE */}
        <div className="col-span-1 md:col-span-12 lg:col-span-12">
          <ControlModule title="Support & Feedback" className="flex flex-col md:flex-row gap-6">
             <div className="flex-1 space-y-4">
                <RockerSwitch 
                  label="Push Notifications" 
                  checked={isSubscribed} 
                  onChange={isSubscribed ? unsubscribeFromPush : subscribeToPush}
                  disabled={pushLoading}
                />
             </div>
             <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                <ActionButton label="Help Center" icon={FiHelpCircle} onClick={() => navigate('/help')} />
                <ActionButton label="Report Bug" icon={FiFlag} onClick={() => setShowReportModal(true)} />
                <ActionButton label="Legal & Privacy" icon={FiShield} onClick={() => navigate('/privacy')} />
             </div>
          </ControlModule>
        </div>

        {/* 7. EMERGENCY EJECT (Logout) */}
        <div className="col-span-1 md:col-span-12 mt-8 mb-10">
          <button
            onClick={handleLogout}
            className="
              group w-full relative overflow-hidden rounded-xl p-6
              bg-bg-main border-2 border-red-500/20
              shadow-neu-flat-light dark:shadow-neu-flat-dark
              active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark active:scale-[0.99]
              transition-all duration-200
            "
          >
            {/* Warning Stripes Pattern */}
            <div className="absolute inset-0 opacity-5 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,rgba(239,68,68,0.05)_10px,rgba(239,68,68,0.05)_20px)]"></div>
            
            <div className="relative z-10 flex flex-col items-center justify-center gap-2 text-red-500 group-hover:text-red-600">
              <FiLogOut size={32} />
              <span className="text-xl font-black uppercase tracking-[0.2em]">Emergency Eject</span>
              <span className="text-xs font-mono opacity-70">Terminate All Sessions</span>
            </div>
          </button>
        </div>

      </div>

      {/* MODALS */}
      {showReportModal && <ReportBugModal onClose={() => setShowReportModal(false)} />}
    </div>
  );
}