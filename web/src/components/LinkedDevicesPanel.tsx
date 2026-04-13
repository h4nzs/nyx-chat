import React, { useState, useEffect } from 'react';
import { FiMonitor, FiSmartphone, FiTrash2, FiRefreshCw, FiShield } from 'react-icons/fi';
import { authFetch, api } from '@lib/api';
import toast from 'react-hot-toast';
import { useMessageStore } from '@store/message';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useModalStore } from '@store/modal';
import i18n from '../i18n';
import { useTranslation } from 'react-i18next';

interface Device {
    id: string;
    name: string;
    lastActiveAt: string;
    createdAt: string;
    isCurrent: boolean;
}

export const LinkedDevicesPanel: React.FC = () => {
    const { t } = useTranslation('settings');
    const [devices, setDevices] = useState<Device[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const broadcastHistorySync = useMessageStore(state => state.broadcastHistorySync);
    const user = useAuthStore(state => state.user);
    const conversations = useConversationStore(state => state.conversations);

    const loadDevices = async () => {
        try {
            setIsLoading(true);
            const data = await authFetch<Device[]>('/api/users/me/devices');
            setDevices(data);
        } catch (error) {
            toast.error(i18n.t('errors:failed_to_load_linked_devices', 'Failed to load linked devices'));
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadDevices();
    }, []);

    const handleRevoke = async (deviceId: string) => {
        useModalStore.getState().showConfirm(
            t('linked_devices.revoke_title', "Revoke Device"),
            t('linked_devices.revoke_desc', "Are you sure you want to log out this device? It will lose access to all encrypted chats."),
            async () => {
                try {
                    await api(`/api/users/me/devices/${deviceId}`, { method: 'DELETE' });
                    toast.success(i18n.t('common:device_revoked_successfully', 'Device revoked successfully'));
                    setDevices(prev => prev.filter(d => d.id !== deviceId));
                } catch (error) {
                    toast.error(i18n.t('errors:failed_to_revoke_device', 'Failed to revoke device'));
                }
            }
        );
    };

    const handleSyncHistory = async () => {
        // Cari ruang chat "Saved Messages" (Chat dengan diri sendiri)
        const selfChat = conversations.find(c => !c.isGroup && c.participants.length === 1 && c.participants[0].id === user?.id);
        
        if (!selfChat) {
            toast.error(i18n.t('errors:please_start_a_chat_with_yourself_saved_', 'Please start a chat with yourself (\'Saved Messages\') first to use as a sync channel.'));
            return;
        }

        try {
            await broadcastHistorySync(selfChat.id);
            toast.success(i18n.t('common:history_sync_payload_broadcasted_success', 'History sync payload broadcasted successfully.'));
        } catch (e) {
            console.error("Failed to broadcast history sync:", e);
            toast.error(i18n.t('errors:failed_to_broadcast_history_sync', 'Failed to broadcast history sync.'));
        }
    };

    if (isLoading) return <div className="p-4 text-center text-text-secondary">Loading devices...</div>;

    return (
        <div className="relative bg-bg-main rounded-xl p-6 overflow-hidden shadow-neu-flat dark:shadow-neu-flat-dark border-t border-white/40 dark:border-white/5">
            {/* VISUAL ANCHORS (The "Rivets") */}
            <div className="absolute top-3 left-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />
            <div className="absolute top-3 right-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />
            <div className="absolute bottom-3 left-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />
            <div className="absolute bottom-3 right-3 w-1.5 h-1.5 rounded-full bg-text-secondary/20 shadow-neu-pressed dark:shadow-neu-pressed-dark" />

            {/* Header with "Groove" line */}
            <div className="flex items-center gap-4 mb-6 pl-2">
              <div className="p-2 rounded-lg bg-bg-main shadow-neu-icon dark:shadow-neu-icon-dark text-accent">
                <FiShield size={16} />
              </div>
              <h3 className="text-xs font-black tracking-[0.2em] uppercase text-text-secondary hidden sm:block">Linked Devices</h3>
              <div className="h-[2px] flex-1 bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark rounded-full"></div>
              
              <button 
                  onClick={handleSyncHistory}
                  className="flex items-center gap-2 px-4 py-2 bg-bg-main text-accent shadow-neu-flat dark:shadow-neu-flat-dark active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark rounded-xl text-xs font-bold uppercase tracking-wider transition-all hover:brightness-110"
              >
                  <FiRefreshCw size={14} />
                  Sync History
              </button>
            </div>

            <div className="relative z-10 pl-2 pr-2 space-y-4">
                {devices.map(device => {
                    const isMobile = device.name.toLowerCase().includes('ios') || device.name.toLowerCase().includes('android');
                    return (
                        <div key={device.id} className="p-4 flex items-center justify-between rounded-xl bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark">
                            <div className="flex items-center gap-4">
                                <div className={`p-3 rounded-full shadow-neu-flat dark:shadow-neu-flat-dark ${device.isCurrent ? 'text-emerald-500' : 'text-text-secondary'}`}>
                                    {isMobile ? <FiSmartphone className="w-5 h-5" /> : <FiMonitor className="w-5 h-5" />}
                                </div>
                                <div className="min-w-0 pr-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="font-bold text-sm text-text-primary truncate max-w-[150px] sm:max-w-xs">{device.name || 'Unknown Device'}</p>
                                        {device.isCurrent && (
                                            <span className="px-2 py-0.5 shadow-neu-flat dark:shadow-neu-flat-dark text-emerald-500 text-[10px] uppercase font-bold rounded-md whitespace-nowrap">
                                                This Device
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-[10px] text-text-secondary mt-1 uppercase tracking-wider font-mono truncate">
                                        Active: {new Date(device.lastActiveAt).toLocaleDateString()} {new Date(device.lastActiveAt).toLocaleTimeString()}
                                    </p>
                                </div>
                            </div>

                            {!device.isCurrent && (
                                <button 
                                    onClick={() => handleRevoke(device.id)}
                                    className="p-3 text-red-500 shadow-neu-flat dark:shadow-neu-flat-dark active:shadow-neu-pressed dark:active:shadow-neu-pressed-dark rounded-xl transition-all hover:scale-105 shrink-0"
                                    title="Revoke Access"
                                >
                                    <FiTrash2 className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
