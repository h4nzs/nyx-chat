import { create } from 'zustand';
import useDynamicIslandStore, { NotificationActivity } from './dynamicIsland';
import { User } from './auth';

export type AppNotification = {
  id: string;
  message: string;
  timestamp: number;
  read: boolean;
  link?: string; // Optional link to navigate to
  sender?: Partial<User>;
};

type NotificationState = {
  notifications: AppNotification[];
  unreadCount: number;
  addNotification: (notification: Omit<AppNotification, 'id' | 'read' | 'timestamp'>) => void;
  markAllAsRead: () => void;
  clearNotifications: () => void;
  removeNotificationsForConversation: (conversationId: string) => void;
};

const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  unreadCount: 0,

  addNotification: (notification) => {
    const newNotification: AppNotification = {
      id: Date.now().toString(), // Simple unique ID
      timestamp: Date.now(),
      read: false,
      ...notification,
    };
    set(state => ({
      notifications: [newNotification, ...state.notifications],
      unreadCount: state.unreadCount + 1,
    }));

    // Integrate with Dynamic Island
    if (newNotification.sender && newNotification.link) {
      const activity: Omit<NotificationActivity, 'id'> = {
        type: 'notification',
        sender: newNotification.sender,
        message: newNotification.message,
        link: newNotification.link,
      };
      useDynamicIslandStore.getState().addActivity(activity, 5000); // Auto-hide after 5 seconds
    }
  },

  markAllAsRead: () => {
    set(state => ({
      notifications: state.notifications.map(n => ({ ...n, read: true })),
      unreadCount: 0,
    }));
  },

  clearNotifications: () => {
    set({ notifications: [], unreadCount: 0 });
  },

  removeNotificationsForConversation: (conversationId) => {
    set(state => ({
      notifications: state.notifications.filter(n => n.link !== conversationId),
    }));
  },
}));

export default useNotificationStore;