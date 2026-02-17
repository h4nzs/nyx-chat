import { useEffect, useState } from 'react';
import { authFetch } from '@lib/api';
import toast from 'react-hot-toast';

export default function AdminDashboard() {
  const [metrics, setMetrics] = useState<any>(null);
  const [searchId, setSearchId] = useState('');
  const [loadingAction, setLoadingAction] = useState(false);

  useEffect(() => {
    loadMetrics();
  }, []);

  const loadMetrics = () => {
    authFetch('/api/admin/system-status')
      .then((res: any) => setMetrics(res))
      .catch((err: any) => toast.error("Failed to load metrics"));
  };

  const handleBan = async () => {
    if (!searchId) return toast.error("Enter User ID");
    const reason = prompt("Enter ban reason:");
    if (!reason) return;

    setLoadingAction(true);
    try {
      await authFetch('/api/admin/ban', {
        method: 'POST',
        body: JSON.stringify({ userId: searchId, reason })
      });
      toast.success("User Banned & Kicked!");
      loadMetrics(); // Refresh stats
    } catch (e: any) {
      toast.error(e.message || "Failed to ban");
    } finally {
      setLoadingAction(false);
    }
  };

  const handleUnban = async () => {
    if (!searchId) return toast.error("Enter User ID");
    if (!confirm("Unban this user?")) return;

    setLoadingAction(true);
    try {
      await authFetch('/api/admin/unban', {
        method: 'POST',
        body: JSON.stringify({ userId: searchId })
      });
      toast.success("User Unbanned!");
      loadMetrics();
    } catch (e: any) {
      toast.error(e.message || "Failed to unban");
    } finally {
      setLoadingAction(false);
    }
  };

  if (!metrics) return (
    <div className="flex items-center justify-center h-screen bg-bg-main text-text-secondary font-mono">
      INITIALIZING SYSTEM LINK...
    </div>
  );

  return (
    <div className="min-h-screen bg-bg-main text-text-primary p-8 font-mono overflow-y-auto">
      <h1 className="text-2xl text-accent mb-6 tracking-widest border-b border-white/10 pb-4">
        NYX MISSION CONTROL
      </h1>
      
      {/* Grid Statistik */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-bg-surface p-6 rounded-xl border border-white/10 shadow-lg">
          <h3 className="text-xs font-bold opacity-50 mb-2 tracking-wider">VPS RAM USAGE</h3>
          <p className="text-xl font-bold">{metrics.vps.ramUsage}</p>
          <p className="text-xs text-text-secondary mt-2">Uptime: {metrics.vps.uptime}</p>
        </div>
        <div className="bg-bg-surface p-6 rounded-xl border border-white/10 shadow-lg">
          <h3 className="text-xs font-bold opacity-50 mb-2 tracking-wider">ACTIVE DATABASE</h3>
          <div className="flex justify-between items-end">
             <div>
                <p className="text-2xl font-bold">{metrics.db.totalUsers}</p>
                <p className="text-xs text-text-secondary">Users</p>
             </div>
             <div className="text-right">
                <p className="text-xl font-bold text-accent">{metrics.db.totalMessages}</p>
                <p className="text-xs text-text-secondary">Messages</p>
             </div>
          </div>
        </div>
        <div className="bg-bg-surface p-6 rounded-xl border border-white/10 shadow-lg">
          <h3 className="text-xs font-bold opacity-50 mb-2 tracking-wider">R2 STORAGE</h3>
          <p className="text-2xl font-bold text-blue-400">{metrics.storage.totalSizeMB}</p>
          <p className="text-xs text-text-secondary mt-2">{metrics.storage.totalFiles} Files</p>
        </div>
      </div>

      {/* Control Panel Ban */}
      <div className="bg-bg-surface p-8 rounded-xl border border-red-500/20 shadow-lg max-w-2xl">
        <h2 className="text-lg text-red-500 mb-6 font-bold flex items-center gap-2">
          <span>⚠️</span> ENFORCEMENT PROTOCOL
        </h2>
        <div className="flex gap-4 flex-col md:flex-row">
          <input 
            type="text" 
            placeholder="Target User ID..." 
            className="bg-bg-main p-3 rounded-lg text-text-primary border border-white/10 flex-1 outline-none focus:border-red-500 transition-colors"
            value={searchId}
            onChange={(e) => setSearchId(e.target.value)}
          />
          <div className="flex gap-2">
            <button 
                onClick={handleBan} 
                disabled={loadingAction}
                className="bg-red-500 px-6 py-3 rounded-lg text-white font-bold hover:bg-red-600 disabled:opacity-50 transition-all shadow-lg shadow-red-500/20"
            >
                BAN
            </button>
            <button 
                onClick={handleUnban} 
                disabled={loadingAction}
                className="bg-green-600 px-6 py-3 rounded-lg text-white font-bold hover:bg-green-700 disabled:opacity-50 transition-all shadow-lg shadow-green-500/20"
            >
                UNBAN
            </button>
          </div>
        </div>
        <p className="text-xs text-text-secondary mt-4 opacity-60">
           Total Banned Users: {metrics.db.bannedUsers}
        </p>
      </div>
    </div>
  );
}
