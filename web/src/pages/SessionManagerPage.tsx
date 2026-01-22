import { useState, useEffect } from 'react';
import { api } from '@lib/api';
import { toast } from 'react-hot-toast';
import { Spinner } from '@components/Spinner';
import { Link } from 'react-router-dom';
import { FiMonitor, FiSmartphone, FiLogOut } from 'react-icons/fi';

// This would typically come from a library like `ua-parser-js`
const parseUserAgent = (ua: string) => {
  if (!ua) return { browser: 'Unknown', os: 'Device' };
  if (ua.includes('Firefox')) return { browser: 'Firefox', os: 'Desktop' };
  if (ua.includes('Chrome')) return { browser: 'Chrome', os: 'Desktop' };
  if (ua.includes('Safari')) return { browser: 'Safari', os: 'Desktop' };
  if (ua.includes('Android')) return { browser: 'Android', os: 'Mobile' };
  if (ua.includes('iPhone')) return { browser: 'iPhone', os: 'Mobile' };
  return { browser: 'Unknown', os: 'Device' };
};

const SessionCard = ({ session, onLogout, isCurrent }: { session: any, onLogout: (jti: string) => void, isCurrent: boolean }) => {
  const { browser, os } = parseUserAgent(session.userAgent);
  const Icon = os === 'Mobile' ? FiSmartphone : FiMonitor;

  return (
    <div className="card-neumorphic flex items-center justify-between">
      <div className="flex items-center gap-4">
        <Icon size={24} className="text-text-secondary" />
        <div>
          <p className="font-semibold text-text-primary">{browser} on {os}</p>
          <p className="text-sm text-text-secondary">
            IP: {session.ipAddress} {isCurrent && <span className="text-green-500 font-semibold">(This session)</span>}
          </p>
          <p className="text-xs text-text-secondary">Last used: {new Date(session.lastUsedAt).toLocaleString()}</p>
        </div>
      </div>
      {!isCurrent && (
        <button
          onClick={() => onLogout(session.jti)}
          className="btn-destructive-neumorphic flex items-center gap-2 px-3 py-2 rounded-lg text-destructive-foreground transition-colors"
        >
          <FiLogOut />
          <span>Logout</span>
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
        
        // Deduplicate sessions, keeping only the most recent for each user agent
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
    const toastId = toast.loading('Logging out session...');
    try {
      await api(`/api/sessions/${jti}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.jti !== jti));
      toast.success('Session logged out successfully.', { id: toastId });
    } catch (error) {
      toast.error('Failed to log out session.', { id: toastId });
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-bg-main text-text-primary font-sans">
      <header className="p-4 border-b border-border flex items-center gap-4 flex-shrink-0">
        <Link to="/settings" className="touch-target p-2.5 rounded-full text-text-secondary shadow-neumorphic-convex-sm active:shadow-neumorphic-pressed-sm transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
        </Link>
        <h1 className="text-xl font-bold text-text-primary">Active Sessions</h1>
      </header>
      <main className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-2xl mx-auto space-y-4">
          <p className="text-sm text-text-secondary">This is a list of devices that have logged into your account. Revoke any session that you do not recognize.</p>
          {loading ? (
            <div className="flex justify-center py-8"><Spinner size="lg" /></div>
          ) : (
            sessions.map(session => (
              <SessionCard
                key={session.jti}
                session={session}
                onLogout={handleLogoutSession}
                isCurrent={session.isCurrent} // We will need the API to tell us which session is the current one
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}
