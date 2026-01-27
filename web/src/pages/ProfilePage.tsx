import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { authFetch, handleApiError } from '@lib/api';
import type { User } from '@store/auth';
import { toAbsoluteUrl } from '@utils/url';
import { motion } from 'framer-motion';
import { IoArrowBack, IoPerson, IoMail, IoCalendar, IoInformationCircle } from 'react-icons/io5';

type ProfileUser = User & {
  createdAt: string;
  description?: string | null;
};

const DataField = ({ label, value, icon: Icon }: { label: string, value: string | undefined, icon?: any }) => (
  <div className="group">
    <div className="flex items-center gap-2 mb-2 px-1">
      {Icon && <Icon className="text-accent text-xs" />}
      <span className="text-[10px] font-black uppercase tracking-widest text-text-secondary">{label}</span>
    </div>
    <div className="
      w-full p-4 rounded-xl
      bg-bg-main text-text-primary font-medium
      shadow-neu-pressed-light dark:shadow-neu-pressed-dark
      border border-white/20 dark:border-black/20
    ">
      {value || <span className="opacity-40 italic">Not specified</span>}
    </div>
  </div>
);

export default function ProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [user, setUser] = useState<ProfileUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;

    const fetchUser = async () => {
      try {
        setLoading(true);
        const userData = await authFetch<ProfileUser>(`/api/users/${userId}`);
        setUser(userData);
      } catch (e) {
        setError(handleApiError(e));
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, [userId]);

  if (loading) {
    return <div className="h-full flex items-center justify-center bg-bg-main text-text-secondary animate-pulse">Scanning Identity...</div>;
  }

  if (error) {
    return <div className="h-full flex items-center justify-center bg-bg-main text-red-500 font-mono">{error}</div>;
  }

  if (!user) {
    return <div className="h-full flex items-center justify-center bg-bg-main text-text-secondary">Identity Not Found</div>;
  }

  return (
    <div className="min-h-screen bg-bg-main p-4 sm:p-8 flex flex-col items-center">
      {/* Header / Nav */}
      <div className="w-full max-w-2xl mb-8 flex items-center">
        <button
          onClick={() => navigate(-1)}
          className="
            p-3 rounded-full text-text-secondary
            bg-bg-main
            shadow-neu-flat-light dark:shadow-neu-flat-dark
            active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
            hover:text-accent transition-all
          "
        >
          <IoArrowBack size={20} />
        </button>
        <h1 className="ml-6 text-xl font-black uppercase tracking-widest text-text-primary/50">Personnel File</h1>
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, type: "spring" }}
        className="
          w-full max-w-2xl relative overflow-hidden
          bg-bg-main rounded-3xl
          shadow-neu-flat-light dark:shadow-neu-flat-dark
          border border-white/20 dark:border-black/20
        "
      >
        {/* Top Decorative Bar */}
        <div className="h-2 w-full bg-accent/20 flex gap-1">
           <div className="h-full w-1/3 bg-accent/40"></div>
           <div className="h-full w-1/6 bg-accent"></div>
        </div>

        <div className="p-8 sm:p-10 flex flex-col md:flex-row gap-10">
          
          {/* Avatar Column */}
          <div className="flex flex-col items-center">
            <div className="
              relative w-40 h-40 rounded-full 
              shadow-neu-pressed-light dark:shadow-neu-pressed-dark
              p-2 bg-bg-main flex-shrink-0
            ">
              <img
                src={toAbsoluteUrl(user.avatarUrl) || `https://api.dicebear.com/8.x/initials/svg?seed=${user.name}`}
                alt={user.name}
                className="w-full h-full rounded-full object-cover grayscale contrast-125"
              />
              <div className="absolute inset-0 rounded-full shadow-[inset_0_0_20px_rgba(0,0,0,0.2)] pointer-events-none"></div>
            </div>
            
            <div className="mt-6 text-center">
              <h2 className="text-2xl font-bold text-text-primary">{user.name}</h2>
              <div className="
                mt-2 inline-block px-3 py-1 rounded-md 
                bg-bg-main border border-accent/20 text-accent 
                text-xs font-mono uppercase tracking-wider
                shadow-sm
              ">
                @{user.username}
              </div>
            </div>
          </div>

          {/* Data Column */}
          <div className="flex-1 space-y-6">
            <DataField label="Bio-Data" value={user.description || undefined} icon={IoInformationCircle} />
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <DataField 
                label="Registration Date" 
                value={new Date(user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} 
                icon={IoCalendar} 
              />
              {user.email && (
                 <DataField label="Contact Protocol" value={user.email} icon={IoMail} />
              )}
            </div>
          </div>

        </div>
        
        {/* Footer Status */}
        <div className="bg-black/5 dark:bg-white/5 p-4 text-center">
           <p className="text-[10px] font-mono text-text-secondary uppercase tracking-[0.2em]">End of Record</p>
        </div>
      </motion.div>
    </div>
  );
}
