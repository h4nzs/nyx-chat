import { useEffect, useState } from 'react';
import { authFetch } from '@lib/api';
import toast from 'react-hot-toast';
import BanUserModal from '@components/BanUserModal';
import { useModalStore } from '@store/modal';
import { FiRefreshCw, FiUnlock, FiAlertTriangle } from 'react-icons/fi';
import { useAuthStore } from '@store/auth';
import { useNavigate } from 'react-router-dom';

interface BannedUser {
  id: string;
  username: string;
  email: string;
  bannedAt: string;
  banReason: string;
}

export default function AdminDashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState<any>(null);
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([]);
  const [isBanModalOpen, setIsBanModalOpen] = useState(false);
  const { showConfirm } = useModalStore();

  // --- Data Loading Functions ---
  // Defined before useEffect to be available inside it
  const loadMetrics = () => {
    authFetch('/api/admin/system-status')
      .then((res: any) => setMetrics(res))
      .catch((err: any) => toast.error("Failed to load metrics"));
  };

  const loadBannedUsers = () => {
    authFetch<BannedUser[]>('/api/admin/banned-users')
      .then((res) => setBannedUsers(res))
      .catch((err) => console.error("Failed to load banned users", err));
  };

  const loadAllData = () => {
    loadMetrics();
    loadBannedUsers();
  };

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      toast.error("Access Denied");
      navigate('/');
    } else {
      loadAllData();
    }
  }, [user, navigate]);

  const handleUnban = (user: BannedUser) => {
    showConfirm(
      "Unban User",
      `Are you sure you want to lift the ban for @${user.username}?`,
      async () => {
        try {
          await authFetch('/api/admin/unban', {
            method: 'POST',
            body: JSON.stringify({ userId: user.id })
          });
          toast.success(`User @${user.username} unbanned!`);
          loadAllData();
        } catch (e: any) {
          toast.error(e.message || "Failed to unban user.");
        }
      }
    );
  };

  if (user?.role !== 'ADMIN') return null;

  if (!metrics) return (
    <div className="flex items-center justify-center h-screen bg-bg-main text-text-secondary font-mono animate-pulse">
      INITIALIZING SYSTEM LINK...
    </div>
  );

  return (
    <div className="min-h-screen bg-bg-main text-text-primary p-8 font-mono overflow-y-auto">
      <div className="flex items-center justify-between mb-8 border-b border-white/10 pb-4">
        <h1 className="text-2xl text-accent tracking-widest font-bold">
          NYX MISSION CONTROL
        </h1>
        <button 
          onClick={loadAllData} 
          className="p-2 hover:bg-white/5 rounded-full text-text-secondary transition-colors"
          title="Refresh Data"
        >
          <FiRefreshCw size={20} />
        </button>
      </div>
      
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

      {/* Enforcement Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Ban Action */}
        <div className="lg:col-span-1">
          <div className="bg-bg-surface p-8 rounded-xl border border-red-500/20 shadow-lg">
            <h2 className="text-lg text-red-500 mb-6 font-bold flex items-center gap-2">
              <FiAlertTriangle /> ENFORCEMENT
            </h2>
            <p className="text-sm text-text-secondary mb-6 leading-relaxed">
              Suspend user access immediately. This action will forcibly disconnect the user and prevent future logins.
            </p>
            <button 
                onClick={() => setIsBanModalOpen(true)} 
                className="w-full bg-red-500 px-6 py-3 rounded-lg text-white font-bold hover:bg-red-600 transition-all shadow-lg shadow-red-500/20"
            >
                OPEN BAN TERMINAL
            </button>
          </div>
        </div>

        {/* Banned Users List */}
        <div className="lg:col-span-2">
          <div className="bg-bg-surface rounded-xl border border-white/10 shadow-lg overflow-hidden flex flex-col h-[500px]">
            <div className="p-4 border-b border-white/10 bg-white/5 flex justify-between items-center">
              <h3 className="font-bold text-sm tracking-wider">SUSPENDED ACCOUNTS ({bannedUsers.length})</h3>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {bannedUsers.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-text-secondary opacity-50">
                  <FiUnlock size={32} className="mb-2" />
                  <p>No active suspensions</p>
                </div>
              ) : (
                bannedUsers.map(user => (
                  <div key={user.id} className="bg-bg-main p-4 rounded-lg border border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-red-400">@{user.username}</span>
                        <span className="text-xs text-text-secondary bg-white/5 px-2 py-0.5 rounded">{user.email}</span>
                      </div>
                      <div className="text-xs text-text-secondary font-mono mb-1">ID: {user.id}</div>
                      <div className="text-xs text-text-secondary">
                        <span className="opacity-60">Reason:</span> <span className="italic text-white/80">"{user.banReason}"</span>
                      </div>
                      <div className="text-[10px] text-text-secondary mt-1 opacity-50">
                        Banned: {new Date(user.bannedAt).toLocaleString()}
                      </div>
                    </div>
                    
                    <button 
                      onClick={() => handleUnban(user)}
                      className="
                        flex items-center gap-2 px-4 py-2 rounded-lg 
                        bg-green-500/10 text-green-500 border border-green-500/20
                        hover:bg-green-500 hover:text-white transition-all text-xs font-bold uppercase
                        self-start md:self-center
                      "
                    >
                      <FiUnlock /> Unban
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <BanUserModal 
        isOpen={isBanModalOpen} 
        onClose={() => setIsBanModalOpen(false)}
        onSuccess={loadAllData}
      />
    </div>
  );
}
