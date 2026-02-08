import { useState, useEffect } from 'react';
import { api } from '@lib/api';
import { toast } from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { Link } from 'react-router-dom';
import { FiMonitor, FiSmartphone, FiLogOut, FiChevronLeft, FiServer } from 'react-icons/fi';

const parseUserAgent = (ua: string) => {
  if (!ua) return { browser: 'Unknown', os: 'Device' };
  if (ua.includes('Firefox')) return { browser: 'Firefox', os: 'Desktop' };
  if (ua.includes('Chrome')) return { browser: 'Chrome', os: 'Desktop' };
  if (ua.includes('Safari')) return { browser: 'Safari', os: 'Desktop' };
  if (ua.includes('Android')) return { browser: 'Android', os: 'Mobile' };
  if (ua.includes('iPhone')) return { browser: 'iPhone', os: 'Mobile' };
  return { browser: 'Unknown', os: 'Device' };
};

const SessionBlade = ({ session, onLogout, isCurrent }: { session: any, onLogout: (jti: string) => void, isCurrent: boolean }) => {
  const { browser, os } = parseUserAgent(session.userAgent);
  const Icon = os === 'Mobile' ? FiSmartphone : FiMonitor;

  return (
    <div className={`
      relative group
      flex items-center justify-between p-4 rounded-xl mb-4
      bg-bg-main
      shadow-neu-flat-light dark:shadow-neu-flat-dark
      border border-white/20 dark:border-black/20
      ${isCurrent ? 'ring-1 ring-green-500/50' : ''}
    `}>
      {/* LED Indicator */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-12 bg-bg-main rounded-r-md flex flex-col justify-center gap-1">
         <div className={`w-1 h-8 rounded-r-sm mx-auto ${isCurrent ? 'bg-green-500 shadow-[0_0_8px_lime]' : 'bg-gray-400'}`}></div>
      </div>

      <div className="flex items-center gap-6 pl-4">
        <div className={`
          p-3 rounded-xl 
          ${isCurrent ? 'bg-bg-main shadow-neu-pressed-light dark:shadow-neu-pressed-dark text-green-500' : 'bg-bg-main shadow-neu-pressed-light dark:shadow-neu-pressed-dark text-text-secondary'}
        `}>
          <Icon size={24} />
        </div>
        
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-bold text-text-primary uppercase tracking-wide text-sm">{os} / {browser}</h3>
            {isCurrent && (
               <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-green-500 text-white shadow-sm">CURRENT</span>
            )}
          </div>
          
          <div className="font-mono text-xs text-text-secondary mt-1 space-y-0.5 opacity-80">
            <p>IP: <span className="text-text-primary">{session.ipAddress}</span></p>
            <p>LAST_PING: {new Date(session.lastUsedAt).toLocaleString()}</p>
          </div>
        </div>
      </div>

      {!isCurrent && (
        <button
          onClick={() => onLogout(session.jti)}
          className="
            p-3 rounded-xl text-red-500
            bg-bg-main
            shadow-neu-flat-light dark:shadow-neu-flat-dark
            active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
            hover:text-red-600 hover:scale-105 active:scale-95 transition-all
          "
          title="Eject Session"
        >
          <FiLogOut size={20} />
        </button>
      )}
    </div>
  );
};

export default function SessionManagerPage() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const data = await api<{ sessions: any[] }>('/api/sessions');
        
        const uniqueSessions = new Map<string, any>();
        for (const session of data.sessions) {
          const existing = uniqueSessions.get(session.userAgent);
          if (!existing || new Date(session.lastUsedAt) > new Date(existing.lastUsedAt)) {
            uniqueSessions.set(session.userAgent, session);
          }
        }
        
        const processedSessions = Array.from(uniqueSessions.values())
          .sort((a, b) => new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime());

        setSessions(processedSessions);

      } catch (error) {
        toast.error('Failed to load active sessions.');
      } finally {
        setLoading(false);
      }
    };
    fetchSessions();
  }, []);

  const handleLogoutSession = async (jti: string) => {
    const toastId = toast.loading('Ejecting session...');
    try {
      await api(`/api/sessions/${jti}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.jti !== jti));
      toast.success('Session terminated.', { id: toastId });
    } catch (error) {
      toast.error('Ejection failed.', { id: toastId });
    }
  };

  return (
    <div className="min-h-screen bg-bg-main flex flex-col items-center p-4">
      
      {/* Header */}
      <div className="w-full max-w-3xl mb-8 mt-4 flex items-center justify-between">
         <Link 
            to="/settings" 
            className="
              p-3 rounded-xl text-text-secondary
              bg-bg-main
              shadow-neu-flat-light dark:shadow-neu-flat-dark
              active:shadow-neu-pressed-light dark:active:shadow-neu-pressed-dark
              hover:text-accent transition-all
            "
          >
            <FiChevronLeft size={20} />
          </Link>
          <div className="flex flex-col items-end">
             <h1 className="text-xl font-black uppercase tracking-widest text-text-primary">Network Nodes</h1>
             <p className="text-[10px] font-mono text-text-secondary uppercase">Active Connections Monitor</p>
          </div>
      </div>

      <div className="w-full max-w-3xl flex-1">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 text-text-secondary">
             <Spinner size="lg" />
             <p className="mt-4 font-mono text-xs animate-pulse">Scanning Network...</p>
          </div>
        ) : (
          <div className="space-y-6">
             {/* Rack Mount Rails - Visual Decoration */}
             <div className="hidden md:block fixed left-4 top-0 bottom-0 w-2 bg-[repeating-linear-gradient(0deg,transparent,transparent_20px,rgba(0,0,0,0.1)_20px,rgba(0,0,0,0.1)_21px)]"></div>
             <div className="hidden md:block fixed right-4 top-0 bottom-0 w-2 bg-[repeating-linear-gradient(0deg,transparent,transparent_20px,rgba(0,0,0,0.1)_20px,rgba(0,0,0,0.1)_21px)]"></div>

            {sessions.map(session => (
              <SessionBlade
                key={session.jti}
                session={session}
                onLogout={handleLogoutSession}
                isCurrent={session.isCurrent} 
              />
            ))}
            
            {sessions.length === 0 && (
               <div className="p-8 text-center text-text-secondary opacity-50">
                  <FiServer size={48} className="mx-auto mb-4" />
                  <p>No active nodes detected.</p>
               </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
