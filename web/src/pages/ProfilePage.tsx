import { useState, useRef, ChangeEvent, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore, type User } from '@store/auth';
import { authFetch, handleApiError } from '@lib/api';
import { toAbsoluteUrl } from '@utils/url';
import { FiEdit2, FiShield, FiCpu, FiGlobe, FiActivity, FiKey, FiCheck, FiArrowLeft } from 'react-icons/fi';
import { toast } from 'react-hot-toast';

type ProfileUser = User & {
  createdAt?: string;
};

export default function ProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user: me, updateProfile, updateAvatar } = useAuthStore();
  
  const [profileUser, setProfileUser] = useState<ProfileUser | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isMe = me?.id === userId;

  useEffect(() => {
    const fetchUser = async () => {
      if (!userId) return;
      setIsFetching(true);
      try {
        if (isMe && me) {
          setProfileUser(me);
          setName(me.name);
          setBio(me.description || '');
        } else {
          const userData = await authFetch<ProfileUser>(`/api/users/${userId}`);
          setProfileUser(userData);
          setName(userData.name);
          setBio(userData.description || '');
        }
      } catch (e) {
        toast.error(handleApiError(e));
      } finally {
        setIsFetching(false);
      }
    };
    fetchUser();
  }, [userId, me, isMe]);

  const stats = [
    { label: 'Security Clearance', value: 'LEVEL 4', color: 'text-emerald-500', icon: FiShield },
    { label: 'Encryption Protocol', value: 'AES-256-GCM', color: 'text-accent', icon: FiKey },
    { label: 'Home Server', value: 'ap-southeast-1', color: 'text-blue-500', icon: FiGlobe },
    { label: 'Session Status', value: 'ENCRYPTED', color: 'text-emerald-500', icon: FiActivity },
  ];

  const handleSave = async () => {
    if (!isMe) return;
    setIsLoading(true);
    try {
      await updateProfile({ name, description: bio });
      // Update local state if needed, but store update should trigger re-render via isMe check if we depend on me
      setIsEditing(false);
    } catch (error) {
      // Toast already handled by updateProfile if implemented, else:
      toast.error('Update Failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAvatarUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!isMe) return;
    const file = e.target.files?.[0];
    if (file) {
      try {
        await updateAvatar(file);
      } catch (error) {
        // Error handled in store
      }
    }
  };

  if (isFetching) return <div className="h-full flex items-center justify-center bg-bg-main"><div className="animate-spin rounded-full h-8 w-8 border-t-2 border-accent"></div></div>;
  if (!profileUser) return <div className="h-full flex items-center justify-center bg-bg-main text-text-secondary">User not found</div>;

  return (
    <div className="h-full overflow-y-auto bg-bg-main p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        
        {/* HEADER: Operator Status */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-black/5 dark:border-white/5 pb-6">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => navigate(-1)}
              className="p-3 rounded-full bg-bg-main shadow-neu-flat dark:shadow-neu-flat-dark active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark hover:text-accent transition-all"
            >
              <FiArrowLeft />
            </button>
            <div>
              <h1 className="text-3xl md:text-4xl font-black uppercase tracking-tighter text-text-primary">
                Operator Profile
              </h1>
              <p className="font-mono text-xs text-text-secondary uppercase tracking-widest mt-1">
                ID: {profileUser.id.substring(0, 8)}-{profileUser.id.substring(profileUser.id.length - 4)} • <span className="text-emerald-500">ACTIVE</span>
              </p>
            </div>
          </div>
          
          {isMe && (
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
                   className="flex items-center gap-2 px-6 py-2 bg-bg-main text-text-primary rounded-lg font-bold shadow-neu-flat dark:shadow-neu-flat-dark hover:text-accent active:shadow-neu-pressed transition-all"
                 >
                   <FiEdit2 size={16} />
                   EDIT_RECORD
                 </button>
               )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* COLUMN 1: Visual ID Card */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-bg-main rounded-2xl p-6 shadow-neu-flat dark:shadow-neu-flat-dark border border-white/50 dark:border-white/5 text-center relative overflow-hidden group">
              {/* ID Badge Aesthetics */}
              <div className="absolute top-0 left-0 w-full h-1 bg-accent/50" />
              <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_#10b981]" />
              
              <div className="relative mx-auto w-40 h-40 mb-4">
                <div className="w-full h-full rounded-full p-2 bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark">
                  <img 
                    src={toAbsoluteUrl(profileUser.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${profileUser.name}`}
                    alt="Profile" 
                    className="w-full h-full rounded-full object-cover"
                  />
                </div>
                {isMe && (
                  <>
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute bottom-2 right-2 p-2.5 bg-accent text-white rounded-full shadow-lg hover:scale-110 transition-transform"
                    >
                      <FiEdit2 size={14} />
                    </button>
                    <input ref={fileInputRef} type="file" className="hidden" onChange={handleAvatarUpload} />
                  </>
                )}
              </div>

              <h2 className="text-xl font-black text-text-primary uppercase tracking-tight">{profileUser.name}</h2>
              <p className="text-sm font-mono text-text-secondary">@{profileUser.username}</p>
            </div>

            {/* Technical Stats Widget */}
            <div className="bg-bg-main rounded-xl p-5 shadow-neu-flat dark:shadow-neu-flat-dark border border-white/50 dark:border-white/5">
              <h3 className="text-xs font-black uppercase tracking-widest text-text-secondary mb-4 flex items-center gap-2">
                <FiCpu /> System Telemetry
              </h3>
              <div className="space-y-4">
                {stats.map((stat) => (
                  <div key={stat.label} className="flex items-center justify-between p-3 rounded-lg bg-bg-surface/10 border border-black/5 dark:border-white/5">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded bg-bg-main ${stat.color} bg-opacity-10 shadow-neu-pressed dark:shadow-neu-pressed-dark`}>
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

          {/* COLUMN 2: Data Entry */}
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
              <div className="font-mono text-[10px] leading-relaxed text-text-secondary break-all bg-black/5 dark:bg-black/20 p-4 rounded-lg border border-black/5 dark:border-white/5 shadow-neu-pressed dark:shadow-neu-pressed-dark">
                {/* Simulated Key Data - In real app, format actual public key */}
                30 82 01 0a 02 82 01 01 00 c4 23 88 a1 99 b2 77 12 00 22 41 9a 33 ff 12 
                ab 11 90 23 88 12 33 44 55 66 77 88 99 aa bb cc dd ee ff 00 11 22 33 44 
                55 66 77 88 99 aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc 
                dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff ...
              </div>
              {isMe && (
                <div className="mt-4 flex gap-4">
                   <button className="text-xs font-bold text-accent hover:underline uppercase tracking-wide">
                     Refresh Keys
                   </button>
                   <button className="text-xs font-bold text-red-500 hover:underline uppercase tracking-wide">
                     Revoke Access
                   </button>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}