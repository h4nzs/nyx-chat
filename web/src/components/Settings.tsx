import { useState, useRef, ChangeEvent, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '@store/auth';
import { toast } from 'react-hot-toast';
import { Spinner } from '../components/Spinner';
import { toAbsoluteUrl } from '@utils/url';
import { usePushNotifications } from '@hooks/usePushNotifications';
import { useThemeStore, ACCENT_COLORS, AccentColor } from '@store/theme';
import { FiChevronRight, FiEdit2, FiHeart, FiCoffee, FiFlag } from 'react-icons/fi';
import { startRegistration } from '@simplewebauthn/browser';
import { IoFingerPrint } from 'react-icons/io5';
import ReportBugModal from '../components/ReportBugModal';
import { api } from '@lib/api';

// Reusable component for a single setting row
const SettingsRow = ({ title, description, children }: { title: string; description: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between py-4">
    <div className="pr-4">
      <p className="font-medium text-text-primary">{title}</p>
      <p className="text-sm text-text-secondary">{description}</p>
    </div>
    <div>{children}</div>
  </div>
);

const ToggleSwitch = ({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) => (
  <button
    type="button"
    onClick={disabled ? undefined : onChange}
    disabled={disabled}
    className={`toggle-neumorphic ${
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
    }`}
    role="switch"
    aria-checked={checked}
  >
    <span
      aria-hidden="true"
      className={`toggle-neumorphic-thumb ${
        checked ? 'translate-x-6 bg-accent' : 'translate-x-1 bg-bg-surface'
      }`}
    />
  </button>
);

export default function SettingsPage() {
  const { user, updateProfile, updateAvatar, sendReadReceipts, setReadReceipts } = useAuthStore();
  const { theme, toggleTheme, accent, setAccent } = useThemeStore();

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
  const [showEmail, setShowEmail] = useState(user?.showEmailToOthers || false);
  const [readReceipts, setReadReceiptsState] = useState(sendReadReceipts);
  const [isLoading, setIsLoading] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const colorMap: Record<AccentColor, string> = {
    blue: 'hsl(217 91% 60%)',
    green: 'hsl(142 76% 42%)',
    purple: 'hsl(262 80% 64%)',
    orange: 'hsl(25 95% 53%)',
  };

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setDescription(user.description || '');
      setPreviewUrl(user.avatarUrl ? toAbsoluteUrl(user.avatarUrl) || null : null);
      setShowEmail(user.showEmailToOthers || false);
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
        toast('No changes to save.');
        return;
      }
      await Promise.all(promises);
      toast.success('Profile updated successfully!');
    } catch (error: any) {
      const errorMsg = error.details ? JSON.parse(error.details).error : error.message;
      toast.error(`Update failed: ${errorMsg}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePrivacySubmit = async () => {
    const toastId = toast.loading('Saving privacy settings...');
    try {
      await updateProfile({ showEmailToOthers: showEmail });
      setReadReceipts(readReceipts);
      toast.success('Privacy settings saved!', { id: toastId });
    } catch (error) {
      toast.error('Failed to save privacy settings.', { id: toastId });
    }
  };

  // --- WEBAUTHN LOGIC ---
  const handleRegisterPasskey = async () => {
    try {
      toast.loading("Preparing biometric setup...", { id: 'passkey' });
      const options = await api<any>("/api/auth/webauthn/register/options");
      
      toast.loading("Scan your fingerprint/face...", { id: 'passkey' });
      const attResp = await startRegistration(options);
      
      const verificationResp = await api<{ verified: boolean }>("/api/auth/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify(attResp),
      });

      if (verificationResp.verified) {
        toast.success("Passkey registered successfully!", { id: 'passkey' });
      } else {
        throw new Error("Verification failed");
      }
    } catch (error: any) {
      console.error(error);
      if (error.name === 'NotAllowedError') {
        toast.error("Registration cancelled.", { id: 'passkey' });
      } else {
        toast.error(`Failed: ${error.message || "Unknown error"}`, { id: 'passkey' });
      }
    }
  };

  if (!user) return <div className="flex justify-center items-center h-full"><Spinner /></div>;

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-20 p-4">
      
      {/* Profile Card */}
      <form onSubmit={handleProfileSubmit}>
        <div className="card-neumorphic">
          <div className="p-6 space-y-6">
            <h3 className="text-lg font-semibold text-text-primary">Profile</h3>
            <div className="flex flex-col sm:flex-row items-center gap-6">
              <div className="relative group">
                <img
                  src={previewUrl || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`}
                  alt="Avatar Preview"
                  className="w-24 h-24 rounded-full bg-secondary object-cover shadow-sm"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.src = `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`;
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute bottom-0 right-0 bg-bg-surface text-text-primary p-2 rounded-full shadow-neumorphic-convex active:shadow-neumorphic-pressed hover:text-accent transition-colors"
                  aria-label="Change avatar"
                >
                  <FiEdit2 size={16} />
                </button>
                <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/png, image/jpeg, image/gif" className="hidden" />
              </div>
              <div className="flex-1 w-full space-y-3">
                 <input
                  type="text"
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full input-neumorphic text-lg font-bold px-4 py-2"
                  placeholder="Your Name"
                />
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  maxLength={150}
                  className="w-full input-neumorphic text-sm px-4 py-2 resize-none"
                  placeholder="About me..."
                />
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button type="submit" disabled={isLoading} className="btn-primary flex items-center gap-2">
                {isLoading && <Spinner size="sm" className="text-white" />}
                {isLoading ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </div>
        </div>
      </form>

      {/* Appearance Card */}
      <div className="card-neumorphic">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-text-primary mb-2">Appearance</h3>
          <SettingsRow title="Theme" description="Switch between light and dark mode.">
            <ToggleSwitch checked={theme === 'dark'} onChange={toggleTheme} />
          </SettingsRow>
          <div className="border-t border-border my-4"></div>
          <SettingsRow title="Accent Color" description="Choose your preferred accent color.">
            <div className="flex items-center gap-3">
              {ACCENT_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setAccent(color)}
                  style={{ backgroundColor: colorMap[color] }}
                  className={`w-8 h-8 rounded-full transition-all shadow-neumorphic-convex active:shadow-neumorphic-pressed hover:scale-110 ${
                    accent === color ? 'ring-2 ring-offset-2 ring-offset-bg-surface ring-text-primary' : ''
                  }`}
                  aria-label={`Set accent color to ${color}`}
                />
              ))}
            </div>
          </SettingsRow>
        </div>
      </div>

      {/* Privacy & Security Card */}
      <div className="card-neumorphic">
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-text-primary">Privacy & Security</h3>
            <button onClick={handlePrivacySubmit} className="text-sm text-accent hover:underline font-medium">
              Save Privacy
            </button>
          </div>

          <div className="space-y-1">
            <SettingsRow
              title="Biometric Login"
              description="Use Fingerprint or Face ID to login securely."
            >
              <button
                onClick={handleRegisterPasskey}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-bg-main text-text-primary border border-border hover:bg-bg-hover transition-colors shadow-neumorphic-convex active:shadow-neumorphic-pressed text-sm"
              >
                <IoFingerPrint size={18} />
                <span>Register Device</span>
              </button>
            </SettingsRow>

            <SettingsRow title="Send Read Receipts" description="Let others know you have read their messages.">
              <ToggleSwitch checked={readReceipts} onChange={() => setReadReceiptsState(!readReceipts)} />
            </SettingsRow>
            
            <SettingsRow title="Show Email Address" description="Allow others to see your email on your profile.">
              <ToggleSwitch checked={showEmail} onChange={() => setShowEmail(!showEmail)} />
            </SettingsRow>

            <div className="border-t border-border my-4"></div>

            <Link to="/settings/keys" className="block w-full group">
              <div className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-text-primary group-hover:text-accent transition-colors">Encryption Keys</p>
                  <p className="text-sm text-text-secondary">Manage your end-to-end encryption keys.</p>
                </div>
                <FiChevronRight size={20} className="text-text-secondary group-hover:text-accent" />
              </div>
            </Link>
            
            <Link to="/settings/sessions" className="block w-full group">
              <div className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-text-primary group-hover:text-accent transition-colors">Active Sessions</p>
                  <p className="text-sm text-text-secondary">View and manage where your account is logged in.</p>
                </div>
                <FiChevronRight size={20} className="text-text-secondary group-hover:text-accent" />
              </div>
            </Link>
            
            <Link to="/settings/link-device" className="block w-full group">
              <div className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium text-text-primary group-hover:text-accent transition-colors">Link a New Device</p>
                  <p className="text-sm text-text-secondary">Connect a new device via QR code.</p>
                </div>
                <FiChevronRight size={20} className="text-text-secondary group-hover:text-accent" />
              </div>
            </Link>
          </div>
        </div>
      </div>

      {/* Notifications & Support Card */}
      <div className="card-neumorphic">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-text-primary mb-4">Notifications & Support</h3>
          
          <SettingsRow
            title="Push Notifications"
            description={pushLoading ? "Processing..." : isSubscribed ? "Enabled on this device." : "Receive notifications for new messages."}
          >
            <ToggleSwitch
              checked={isSubscribed}
              onChange={isSubscribed ? unsubscribeFromPush : subscribeToPush}
              disabled={pushLoading}
            />
          </SettingsRow>

          <Link to="/help" className="block w-full group border-t border-border mt-2 pt-2">
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium text-text-primary group-hover:text-accent transition-colors">Help & Support</p>
                <p className="text-sm text-text-secondary">Find answers to common questions.</p>
              </div>
              <FiChevronRight size={20} className="text-text-secondary group-hover:text-accent" />
            </div>
          </Link>

          {/* Report Bug Button */}
          <button 
            onClick={() => setShowReportModal(true)}
            className="w-full flex items-center justify-between py-3 text-left group"
          >
            <div>
              <p className="font-medium text-text-primary group-hover:text-red-500 transition-colors">Report a Problem</p>
              <p className="text-sm text-text-secondary">Found a bug? Let us know.</p>
            </div>
            <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30 text-red-500 group-hover:scale-110 transition-transform">
                <FiFlag size={18} />
            </div>
          </button>

          <div className="border-t border-border my-6"></div>

          {/* --- SOCIABUZZ DONATION SECTION --- */}
          <div className="p-6 rounded-2xl bg-bg-main shadow-neumorphic-concave border border-white/10 dark:border-white/5 relative overflow-hidden group">
            
            {/* Hiasan Background Abstrak */}
            <div className="absolute -right-4 -top-4 w-24 h-24 bg-accent/10 rounded-full blur-2xl group-hover:bg-accent/20 transition-all duration-500"></div>

            <div className="relative z-10">
              <h3 className="text-lg font-bold text-text-primary flex items-center gap-2 mb-2">
                <FiHeart className="text-red-500 fill-current animate-pulse" />
                Support Chat Lite
              </h3>
              
              <p className="text-sm text-text-secondary mb-5 leading-relaxed">
                This app runs on a low-cost server. Help us upgrade to a faster server, get more storage, and develop new features.
              </p>

              <a 
                href="https://sociabuzz.com/h4nzs/tribe" 
                target="_blank"
                rel="noopener noreferrer"
                className="
                  flex items-center justify-center gap-3 w-full py-3.5 rounded-xl
                  bg-bg-surface text-accent font-bold tracking-wide
                  shadow-neumorphic-convex 
                  hover:text-accent-hover hover:scale-[1.02]
                  active:shadow-neumorphic-pressed active:scale-[0.98]
                  transition-all duration-300
                "
              >
                <FiCoffee size={20} />
                <span>Buy Me a Coffee</span>
              </a>
              
              <div className="mt-3 text-center">
                <span className="text-[10px] uppercase tracking-widest text-text-tertiary">
                  Via QRIS • GoPay • PayPal • Card
                </span>
              </div>
            </div>
          </div>
          {/* --- END DONATION SECTION --- */}

        </div>
      </div>

      {/* Render Report Modal */}
      {showReportModal && (
        <ReportBugModal onClose={() => setShowReportModal(false)} />
      )}

    </div>
  );
}