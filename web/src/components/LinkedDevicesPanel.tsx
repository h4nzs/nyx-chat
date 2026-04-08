import React, { useState, useEffect } from 'react';
import { FiMonitor, FiSmartphone, FiTrash2, FiRefreshCw, FiShield } from 'react-icons/fi';
import { authFetch, api } from '@lib/api';
import toast from 'react-hot-toast';
import { useMessageStore } from '@store/message';
import { useConversationStore } from '@store/conversation';
import { useAuthStore } from '@store/auth';
import { useModalStore } from '@store/modal';

interface Device {
    id: string;
    name: string;
    lastActiveAt: string;
    createdAt: string;
    isCurrent: boolean;
}

export const LinkedDevicesPanel: React.FC = () => {
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
            toast.error('Failed to load linked devices');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadDevices();
    }, []);

    const handleRevoke = async (deviceId: string) => {
        useModalStore.getState().showConfirm(
            "Revoke Device",
            "Are you sure you want to log out this device? It will lose access to all encrypted chats.",
            async () => {
                try {
                    await api(`/api/users/me/devices/${deviceId}`, { method: 'DELETE' });
                    toast.success('Device revoked successfully');
                    setDevices(prev => prev.filter(d => d.id !== deviceId));
                } catch (error) {
                    toast.error('Failed to revoke device');
                }
            }
        );
    };

    const handleSyncHistory = async () => {
        // Cari ruang chat "Saved Messages" (Chat dengan diri sendiri)
        const selfChat = conversations.find(c => !c.isGroup && c.participants.length === 1 && c.participants[0].id === user?.id);
        
        if (!selfChat) {
            toast.error("Please start a chat with yourself ('Saved Messages') first to use as a sync channel.");
            return;
        }

        try {
            await broadcastHistorySync(selfChat.id);
            toast.success("History sync payload broadcasted successfully.");
        } catch (e) {
            console.error("Failed to broadcast history sync:", e);
            toast.error("Failed to broadcast history sync.");
        }
    };

    if (isLoading) return <div className="p-4 text-center text-zinc-400">Loading devices...</div>;

    return (
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-900/50">
                <div>
                    <h3 className="text-lg font-medium text-zinc-100 flex items-center gap-2">
                        <FiShield className="w-5 h-5 text-emerald-500" />
                        Linked Devices
                    </h3>
                    <p className="text-xs text-zinc-400 mt-1">Manage devices that can decrypt your messages.</p>
                </div>
                <button 
                    onClick={handleSyncHistory}
                    className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 rounded-lg text-sm font-medium transition-colors"
                >
                    <FiRefreshCw className="w-4 h-4" />
                    Sync History
                </button>
            </div>

            <div className="divide-y divide-zinc-800/50">
                {devices.map(device => {
                    const isMobile = device.name.toLowerCase().includes('ios') || device.name.toLowerCase().includes('android');
                    return (
                        <div key={device.id} className="p-4 flex items-center justify-between hover:bg-zinc-800/20 transition-colors">
                            <div className="flex items-center gap-4">
                                <div className={`p-3 rounded-full ${device.isCurrent ? 'bg-emerald-500/10 text-emerald-500' : 'bg-zinc-800 text-zinc-400'}`}>
                                    {isMobile ? <FiSmartphone className="w-6 h-6" /> : <FiMonitor className="w-6 h-6" />}
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <p className="font-medium text-zinc-200">{device.name || 'Unknown Device'}</p>
                                        {device.isCurrent && (
                                            <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-[10px] uppercase font-bold rounded-full">
                                                This Device
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-zinc-500 mt-0.5">
                                        Last active: {new Date(device.lastActiveAt).toLocaleDateString()} at {new Date(device.lastActiveAt).toLocaleTimeString()}
                                    </p>
                                </div>
                            </div>

                            {!device.isCurrent && (
                                <button 
                                    onClick={() => handleRevoke(device.id)}
                                    className="p-2 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 rounded-lg transition-colors"
                                    title="Revoke Access"
                                >
                                    <FiTrash2 className="w-5 h-5" />
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
