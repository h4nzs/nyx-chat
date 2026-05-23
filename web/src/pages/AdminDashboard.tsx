import { useEffect, useState } from 'react';
import { authFetch } from '@lib/api';
import toast from 'react-hot-toast';
import BanUserModal from '@components/BanUserModal';
import { useModalStore } from '@store/modal';
import { useShallow } from 'zustand/react/shallow';
import { FiRefreshCw, FiUnlock, FiAlertTriangle, FiCopy } from 'react-icons/fi';
import { useAuthStore } from '@store/auth';
import { useNavigate } from 'react-router-dom';
import i18n from '../i18n';

import { useTranslation } from 'react-i18next';

interface BannedUser {
  id: string;
  username: string;
  email: string;
  bannedAt: string;
  banReason: string;
}

interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  allowedDomains: string[];
  isActive: boolean;
  createdAt: string;
}

export default function AdminDashboard() {
  const { t } = useTranslation('admin');
  const { user } = useAuthStore(useShallow(s => ({ user: s.user })));
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'tenants'>('dashboard');

  const [metrics, setMetrics] = useState<{
    vps: { ramUsage: string; uptime: string };
    db: { totalUsers: string; totalMessages: string };
    storage: { totalSizeMB: string; totalFiles: string };
  } | null>(null);
  const [bannedUsers, setBannedUsers] = useState<BannedUser[]>([]);
  const [isBanModalOpen, setIsBanModalOpen] = useState(false);
  const { showConfirm } = useModalStore(useShallow(s => ({ showConfirm: s.showConfirm })));

  // B2B Tenants State
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [isFetchingTenants, setIsFetchingTenants] = useState(false);
  const [newTenantName, setNewTenantName] = useState('');
  const [newTenantDomains, setNewTenantDomains] = useState('');

  // --- Data Loading Functions ---
  const loadMetrics = () => {
    authFetch('/api/admin/system-status')
      .then((res: unknown) => setMetrics(res as { vps: { ramUsage: string; uptime: string; }; db: { totalUsers: string; totalMessages: string; }; storage: { totalSizeMB: string; totalFiles: string; }; }))
      .catch((_err: unknown) => toast.error(i18n.t('errors:failed_to_load_metrics', 'Failed to load metrics')));
  };

  const loadBannedUsers = () => {
    authFetch<BannedUser[]>('/api/admin/banned-users')
      .then((res) => setBannedUsers(res))
      .catch((err) => console.error("Failed to load banned users", err));
  };

  const fetchTenants = async () => {
    setIsFetchingTenants(true);
    try {
      const res = await authFetch<Tenant[]>('/api/admin/tenants');
      setTenants(res);
    } catch (e) {
      console.error(e);
      toast.error(t('failed_to_load_tenants', 'Failed to load tenants'));
    } finally {
      setIsFetchingTenants(false);
    }
  };

  const loadAllData = () => {
    if (activeTab === 'dashboard') {
      loadMetrics();
      loadBannedUsers();
    } else {
      fetchTenants();
    }
  };

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      toast.error(i18n.t('errors:access_denied', 'Access Denied'));
      navigate('/');
    } else {
      loadAllData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, navigate, activeTab]);

  const handleUnban = (bannedUser: BannedUser) => {
    showConfirm(
      "Unban User",
      `Are you sure you want to lift the ban for @${bannedUser.username}?`,
      async () => {
        try {
          await authFetch('/api/admin/unban', {
            method: 'POST',
            body: JSON.stringify({ userId: bannedUser.id })
          });
          toast.success(i18n.t('common:user_unbanned', `User @${bannedUser.username} unbanned!`, { username: bannedUser.username }));
          loadAllData();
        } catch (e: unknown) {
          toast.error((e instanceof Error ? e.message : 'Unknown error') || "Failed to unban user.");
        }
      }
    );
  };

  const createTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTenantName.trim()) {
      toast.error(t('tenant_name_required', 'Tenant name is required'));
      return;
    }
    
    try {
      await authFetch('/api/admin/tenants', {
        method: 'POST',
        body: JSON.stringify({
          name: newTenantName,
          allowedDomains: newTenantDomains
        })
      });
      toast.success(t('tenant_created', 'Tenant created successfully'));
      setNewTenantName('');
      setNewTenantDomains('');
      fetchTenants();
    } catch (e) {
      console.error(e);
      toast.error(t('failed_to_create_tenant', 'Failed to create tenant'));
    }
  };

  const toggleTenant = async (id: string) => {
    try {
      await authFetch(`/api/admin/tenants/${id}/toggle`, { method: 'PATCH' });
      toast.success(t('tenant_status_updated', 'Tenant status updated'));
      fetchTenants();
    } catch (e) {
      console.error(e);
      toast.error(t('failed_to_toggle_tenant', 'Failed to update tenant status'));
    }
  };

  const copyApiKey = (apiKey: string) => {
    navigator.clipboard.writeText(apiKey);
    toast.success(t('api_key_copied', 'API Key copied to clipboard'));
  };

  if (user?.role !== 'ADMIN') return null;

  if (!metrics && activeTab === 'dashboard') return (
    <div className="flex items-center justify-center h-screen bg-bg-main text-text-secondary font-mono animate-pulse">
      INITIALIZING SYSTEM LINK...
    </div>
  );

  return (
    <div className="min-h-screen bg-bg-main text-text-primary p-8 font-mono overflow-y-auto">
      <div className="flex items-center justify-between mb-6 border-b border-white/10 pb-4">
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

      <div className="flex gap-4 mb-8">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`px-4 py-2 rounded-lg font-bold transition-all ${activeTab === 'dashboard' ? 'bg-accent text-white' : 'bg-white/5 text-text-secondary hover:bg-white/10'}`}
        >
          {t('system_dashboard', 'SYSTEM DASHBOARD')}
        </button>
        <button
          onClick={() => setActiveTab('tenants')}
          className={`px-4 py-2 rounded-lg font-bold transition-all ${activeTab === 'tenants' ? 'bg-accent text-white' : 'bg-white/5 text-text-secondary hover:bg-white/10'}`}
        >
          {t('b2b_tenants', 'B2B ENGINE / TENANTS')}
        </button>
      </div>
      
      {activeTab === 'dashboard' ? (
        <>
          {/* Grid Statistik */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-bg-surface p-6 rounded-xl border border-white/10 shadow-lg">
              <h3 className="text-xs font-bold opacity-50 mb-2 tracking-wider">VPS RAM USAGE</h3>
              <p className="text-xl font-bold">{metrics?.vps.ramUsage}</p>
              <p className="text-xs text-text-secondary mt-2">Uptime: {metrics?.vps.uptime}</p>
            </div>
            <div className="bg-bg-surface p-6 rounded-xl border border-white/10 shadow-lg">
              <h3 className="text-xs font-bold opacity-50 mb-2 tracking-wider">ACTIVE DATABASE</h3>
              <div className="flex justify-between items-end">
                 <div>
                    <p className="text-2xl font-bold">{metrics?.db.totalUsers}</p>
                    <p className="text-xs text-text-secondary">Users</p>
                 </div>
                 <div className="text-right">
                    <p className="text-xl font-bold text-accent">{metrics?.db.totalMessages}</p>
                    <p className="text-xs text-text-secondary">Messages</p>
                 </div>
              </div>
            </div>
            <div className="bg-bg-surface p-6 rounded-xl border border-white/10 shadow-lg">
              <h3 className="text-xs font-bold opacity-50 mb-2 tracking-wider">R2 STORAGE</h3>
              <p className="text-2xl font-bold text-blue-400">{metrics?.storage.totalSizeMB}</p>
              <p className="text-xs text-text-secondary mt-2">{metrics?.storage.totalFiles} Files</p>
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
                  <h3 className="font-bold text-sm tracking-wider">{t('suspended_accounts', 'SUSPENDED ACCOUNTS')} ({bannedUsers.length})</h3>
                </div>
                
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {bannedUsers.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-text-secondary opacity-50">
                      <FiUnlock size={32} className="mb-2" />
                      <p>{t('no_active_suspensions', 'No active suspensions')}</p>
                    </div>
                  ) : (
                    bannedUsers.map(bannedUser => (
                      <div key={bannedUser.id} className="bg-bg-main p-4 rounded-lg border border-white/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-red-400">@{bannedUser.username}</span>
                            <span className="text-xs text-text-secondary bg-white/5 px-2 py-0.5 rounded">{bannedUser.email}</span>
                          </div>
                          <div className="text-xs text-text-secondary font-mono mb-1">ID: {bannedUser.id}</div>
                          <div className="text-xs text-text-secondary">
                            <span className="opacity-60">{t('reason', 'Reason:')}</span> <span className="italic text-white/80">&quot;{bannedUser.banReason}&quot;</span>
                          </div>
                          <div className="text-[10px] text-text-secondary mt-1 opacity-50">
                            {t('banned', 'Banned:')} {new Date(bannedUser.bannedAt).toLocaleString()}
                          </div>
                        </div>
                        
                        <button 
                          onClick={() => handleUnban(bannedUser)}
                          className="
                            flex items-center gap-2 px-4 py-2 rounded-lg 
                            bg-green-500/10 text-green-500 border border-green-500/20
                            hover:bg-green-500 hover:text-white transition-all text-xs font-bold uppercase
                            self-start md:self-center
                          "
                        >
                          <FiUnlock /> {t('unban', 'Unban')}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            <div className="bg-bg-surface p-8 rounded-xl border border-white/10 shadow-lg">
              <h2 className="text-lg text-accent mb-6 font-bold flex items-center gap-2">
                {t('add_tenant', 'ADD TENANT')}
              </h2>
              <form onSubmit={createTenant} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-text-secondary mb-1 uppercase tracking-wider">{t('tenant_name', 'Tenant Name')}</label>
                  <input
                    type="text"
                    value={newTenantName}
                    onChange={(e) => setNewTenantName(e.target.value)}
                    className="w-full bg-bg-main border border-border-subtle rounded-lg px-4 py-2 text-text-primary focus:outline-none focus:border-accent"
                    placeholder="E.g. Acme Corp"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-text-secondary mb-1 uppercase tracking-wider">{t('allowed_domains', 'Allowed Domains (Comma separated)')}</label>
                  <input
                    type="text"
                    value={newTenantDomains}
                    onChange={(e) => setNewTenantDomains(e.target.value)}
                    className="w-full bg-bg-main border border-border-subtle rounded-lg px-4 py-2 text-text-primary focus:outline-none focus:border-accent"
                    placeholder="app.acme.com, acme.local"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full bg-accent px-6 py-3 rounded-lg text-white font-bold hover:bg-accent/80 transition-all shadow-lg shadow-accent/20"
                >
                  {t('generate_key', 'GENERATE KEY')}
                </button>
              </form>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="bg-bg-surface rounded-xl border border-white/10 shadow-lg overflow-hidden flex flex-col h-[500px]">
              <div className="p-4 border-b border-white/10 bg-white/5 flex justify-between items-center">
                <h3 className="font-bold text-sm tracking-wider">{t('b2b_tenants', 'B2B TENANTS')} ({tenants.length})</h3>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {isFetchingTenants && tenants.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-text-secondary opacity-50 animate-pulse">
                    LOADING TENANTS...
                  </div>
                ) : tenants.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-text-secondary opacity-50">
                    <p>{t('no_tenants_found', 'No tenants found')}</p>
                  </div>
                ) : (
                  tenants.map(tenant => (
                    <div key={tenant.id} className="bg-bg-main p-4 rounded-lg border border-white/5 flex flex-col gap-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="font-bold text-lg">{tenant.name}</h4>
                          <div className="text-xs text-text-secondary font-mono mt-1 opacity-70">ID: {tenant.id}</div>
                        </div>
                        <button
                          onClick={() => toggleTenant(tenant.id)}
                          className={`px-3 py-1 text-xs font-bold uppercase rounded border transition-colors ${
                            tenant.isActive 
                              ? 'bg-green-500/10 text-green-500 border-green-500/20 hover:bg-green-500 hover:text-white' 
                              : 'bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500 hover:text-white'
                          }`}
                        >
                          {tenant.isActive ? t('active', 'ACTIVE') : t('inactive', 'INACTIVE')}
                        </button>
                      </div>
                      
                      <div className="text-sm">
                        <span className="text-text-secondary text-xs uppercase tracking-wider block mb-1">{t('allowed_domains', 'Allowed Domains')}:</span>
                        <div className="flex flex-wrap gap-2">
                          {tenant.allowedDomains.length > 0 ? tenant.allowedDomains.map(d => (
                            <span key={d} className="bg-white/5 px-2 py-1 rounded text-xs">{d}</span>
                          )) : <span className="text-text-secondary italic text-xs">None</span>}
                        </div>
                      </div>

                      <div>
                        <span className="text-text-secondary text-xs uppercase tracking-wider block mb-1">API KEY:</span>
                        <div className="flex items-center gap-2">
                          <code className="bg-black/30 px-3 py-2 rounded text-xs text-accent flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                            ••••••••••••••••••••••••••••••••
                          </code>
                          <button
                            onClick={() => copyApiKey(tenant.apiKey)}
                            className="bg-white/5 hover:bg-white/10 p-2 rounded transition-colors text-text-secondary hover:text-white"
                            title="Copy API Key"
                          >
                            <FiCopy />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <BanUserModal 
        isOpen={isBanModalOpen} 
        onClose={() => setIsBanModalOpen(false)}
        onSuccess={loadAllData}
      />
    </div>
  );
}
