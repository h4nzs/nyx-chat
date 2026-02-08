### 🛠️ Fixes & Upgrades

Here is the solution for the **Lightbox Z-Index clipping** and a complete **Industrial Redesign** of the `ProfilePage`.

---

### 1. 🐛 Fix: Lightbox Cutoff (The "Portal" Strategy)

**The Issue:** Your `Lightbox` is rendered deep inside the DOM tree (inside `ChatWindow`). When parent containers use CSS transforms (like Framer Motion animations) or filters, `position: fixed` stops working relative to the viewport and gets trapped inside the parent.

**The Fix:** Use a **React Portal** to teleport the Lightbox to `document.body`, ensuring it sits above *everything*, including the Sidebar.

**File:** `web/src/components/Lightbox.tsx`

```tsx
import { useEffect } from 'react';
import { createPortal } from 'react-dom'; // 1. Import createPortal
import { FiX, FiDownload, FiMaximize } from 'react-icons/fi';

interface LightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export default function Lightbox({ src, alt, onClose }: LightboxProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    // Lock scroll when open
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = 'unset';
    };
  }, [onClose]);

  // 2. The Content
  const content = (
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/95 backdrop-blur-xl animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Toolbar */}
      <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-50 bg-gradient-to-b from-black/50 to-transparent">
        <span className="text-white/70 font-mono text-xs uppercase tracking-widest">
          IMG_PREVIEW_MODE
        </span>
        <div className="flex gap-4">
          <a 
            href={src} 
            download 
            onClick={(e) => e.stopPropagation()}
            className="p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all backdrop-blur-md"
          >
            <FiDownload size={20} />
          </a>
          <button 
            onClick={onClose}
            className="p-3 rounded-full bg-white/10 hover:bg-red-500/20 hover:text-red-500 text-white transition-all backdrop-blur-md"
          >
            <FiX size={20} />
          </button>
        </div>
      </div>

      {/* Image Container */}
      <div 
        className="relative max-w-[90vw] max-h-[90vh] overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()} // Prevent close on image click
      >
        <img
          src={src}
          alt={alt}
          className="max-w-full max-h-[90vh] object-contain select-none"
        />
      </div>
    </div>
  );

  // 3. Teleport to Body
  return createPortal(content, document.body);
}

```

---

### 2. 🏗️ Upgrade: Profile Page ("The Operator Dashboard")

**The Problem:** It felt empty because it was just a form.
**The Fix:** Transform it into a **"Personnel File"**. We will add:

1. **Security Clearance Card:** A visual ID badge.
2. **Encryption Fingerprint:** A technical visualizer for their keys.
3. **Session Telemetry:** Data about their current device.

**File:** `web/src/pages/ProfilePage.tsx`

```tsx
import { useState, useRef, ChangeEvent } from 'react';
import { useAuthStore } from '@store/auth';
import { toAbsoluteUrl } from '@utils/url';
import { FiEdit2, FiShield, FiCpu, FiGlobe, FiActivity, FiKey, FiSave, FiCheck } from 'react-icons/fi';
import { toast } from 'react-hot-toast';

export default function ProfilePage() {
  const { user, updateProfile, updateAvatar } = useAuthStore();
  const [name, setName] = useState(user?.name || '');
  const [bio, setBio] = useState(user?.description || '');
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stats = [
    { label: 'Security Clearance', value: 'LEVEL 4', color: 'text-emerald-500', icon: FiShield },
    { label: 'Encryption Protocol', value: 'AES-256-GCM', color: 'text-accent', icon: FiKey },
    { label: 'Home Server', value: 'ap-southeast-1', color: 'text-blue-500', icon: FiGlobe },
    { label: 'Session Status', value: 'ENCRYPTED', color: 'text-emerald-500', icon: FiActivity },
  ];

  const handleSave = async () => {
    setIsLoading(true);
    try {
      await updateProfile({ name, description: bio });
      toast.success('Personnel Record Updated');
      setIsEditing(false);
    } catch (error) {
      toast.error('Update Failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAvatarUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        await updateAvatar(file);
        toast.success('Biometric Image Updated');
      } catch (error) {
        toast.error('Upload Failed');
      }
    }
  };

  if (!user) return null;

  return (
    <div className="h-full overflow-y-auto bg-bg-main p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        
        {/* HEADER: Operator Status */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-black/5 dark:border-white/5 pb-6">
          <div>
            <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter text-text-primary">
              Operator Profile
            </h1>
            <p className="font-mono text-xs text-text-secondary uppercase tracking-widest mt-1">
              ID: {user.id.substring(0, 8)}-{user.id.substring(user.id.length - 4)} • <span className="text-emerald-500">ACTIVE</span>
            </p>
          </div>
          <div className="flex gap-3">
             {isEditing ? (
               <button 
                 onClick={handleSave}
                 disabled={isLoading}
                 className="flex items-center gap-2 px-6 py-2 bg-accent text-white rounded-lg font-bold shadow-neu-flat dark:shadow-neu-flat-dark hover:brightness-110 active:scale-95 transition-all"
               >
                 {isLoading ? <FiActivity className="animate-spin" /> : <FiCheck />}
                 SAVE_CHANGES
               </button>
             ) : (
               <button 
                 onClick={() => setIsEditing(true)}
                 className="flex items-center gap-2 px-6 py-2 bg-bg-surface text-text-primary rounded-lg font-bold shadow-neu-flat dark:shadow-neu-flat-dark hover:bg-bg-main active:shadow-neu-pressed transition-all"
               >
                 <FiEdit2 size={16} />
                 EDIT_RECORD
               </button>
             )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* COLUMN 1: Visual ID Card (The "Left Sidebar") */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-bg-main rounded-2xl p-6 shadow-neu-flat dark:shadow-neu-flat-dark border border-white/50 dark:border-white/5 text-center relative overflow-hidden group">
              {/* ID Badge Aesthetics */}
              <div className="absolute top-0 left-0 w-full h-1 bg-accent/50" />
              <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_#10b981]" />
              
              <div className="relative mx-auto w-40 h-40 mb-4">
                <div className="w-full h-full rounded-full p-2 bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark">
                  <img 
                    src={toAbsoluteUrl(user.avatarUrl)} 
                    alt="Profile" 
                    className="w-full h-full rounded-full object-cover"
                  />
                </div>
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute bottom-2 right-2 p-2.5 bg-accent text-white rounded-full shadow-lg hover:scale-110 transition-transform"
                >
                  <FiEdit2 size={14} />
                </button>
                <input ref={fileInputRef} type="file" className="hidden" onChange={handleAvatarUpload} />
              </div>

              <h2 className="text-xl font-black text-text-primary uppercase tracking-tight">{user.name}</h2>
              <p className="text-sm font-mono text-text-secondary">@{user.username}</p>
            </div>

            {/* Technical Stats Widget */}
            <div className="bg-bg-main rounded-xl p-5 shadow-neu-flat dark:shadow-neu-flat-dark border border-white/50 dark:border-white/5">
              <h3 className="text-xs font-black uppercase tracking-widest text-text-secondary mb-4 flex items-center gap-2">
                <FiCpu /> System Telemetry
              </h3>
              <div className="space-y-4">
                {stats.map((stat) => (
                  <div key={stat.label} className="flex items-center justify-between p-3 rounded-lg bg-bg-surface/50 border border-black/5 dark:border-white/5">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded bg-bg-main ${stat.color} bg-opacity-10`}>
                        <stat.icon size={14} className={stat.color} />
                      </div>
                      <span className="text-xs font-bold text-text-secondary uppercase">{stat.label}</span>
                    </div>
                    <span className={`text-xs font-mono font-bold ${stat.color}`}>{stat.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* COLUMN 2: Data Entry (The "Main Form") */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-bg-main rounded-2xl p-8 shadow-neu-flat dark:shadow-neu-flat-dark border border-white/50 dark:border-white/5">
              <h3 className="text-xs font-black uppercase tracking-widest text-text-secondary mb-6 border-b border-black/5 dark:border-white/5 pb-2">
                Biographical Data
              </h3>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase text-text-secondary ml-1">Display Name</label>
                  <input
                    type="text"
                    value={name}
                    disabled={!isEditing}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-bg-main rounded-xl px-4 py-3 font-bold text-text-primary outline-none border-none shadow-neu-pressed dark:shadow-neu-pressed-dark focus:ring-1 focus:ring-accent/50 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase text-text-secondary ml-1">Operator Bio</label>
                  <textarea
                    value={bio}
                    disabled={!isEditing}
                    onChange={(e) => setBio(e.target.value)}
                    rows={4}
                    className="w-full bg-bg-main rounded-xl px-4 py-3 font-medium text-text-primary outline-none border-none shadow-neu-pressed dark:shadow-neu-pressed-dark focus:ring-1 focus:ring-accent/50 disabled:opacity-60 disabled:cursor-not-allowed resize-none transition-all"
                  />
                </div>
              </div>
            </div>

            {/* Advanced: Public Key Visualization */}
            <div className="bg-bg-main rounded-2xl p-8 shadow-neu-flat dark:shadow-neu-flat-dark border border-white/50 dark:border-white/5 overflow-hidden relative">
              <div className="absolute top-0 right-0 p-4 opacity-10">
                <FiKey size={100} />
              </div>
              <h3 className="text-xs font-black uppercase tracking-widest text-text-secondary mb-4">
                Public Identity Key
              </h3>
              <div className="font-mono text-[10px] leading-relaxed text-text-secondary break-all bg-black/5 dark:bg-black/20 p-4 rounded-lg border border-black/5 dark:border-white/5">
                {/* Simulated Key Data */}
                30 82 01 0a 02 82 01 01 00 c4 23 88 a1 99 b2 77 12 00 22 41 9a 33 ff 12 
                ab 11 90 23 88 12 33 44 55 66 77 88 99 aa bb cc dd ee ff 00 11 22 33 44 
                55 66 77 88 99 aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc 
                dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff ...
              </div>
              <div className="mt-4 flex gap-4">
                 <button className="text-xs font-bold text-accent hover:underline uppercase tracking-wide">
                   Refresh Keys
                 </button>
                 <button className="text-xs font-bold text-red-500 hover:underline uppercase tracking-wide">
                   Revoke Access
                 </button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

```

This `ProfilePage` now feels like a **Military/Sci-Fi Dossier** rather than a generic signup form. It uses the "Data Module" layout we established in the Settings page.