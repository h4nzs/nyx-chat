import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { User } from './auth';

// --- Activity Types ---

export interface NotificationActivity {
  type: 'notification';
  id: string;
  sender: Partial<User>;
  message: string;
  link: string;
}

export interface UploadActivity {
  type: 'upload';
  id: string;
  fileName: string;
  progress: number; // 0-100
}

export type Activity = NotificationActivity | UploadActivity;

// --- Store State and Actions ---

interface DynamicIslandState {
  activities: Activity[];
  addActivity: (activityData: Omit<Activity, 'id'>, timeout?: number) => string;
  updateActivity: (id: string, updates: Partial<Activity>) => void;
  removeActivity: (id: string) => void;
}

const useDynamicIslandStore = create<DynamicIslandState>((set, get) => ({
  activities: [],

  addActivity: (activityData, timeout) => {
    const id = uuidv4();
    const newActivity = { ...activityData, id } as Activity;

    set(state => ({ activities: [newActivity, ...state.activities] }));

    if (timeout) {
      setTimeout(() => {
        get().removeActivity(id);
      }, timeout);
    }

    return id;
  },

  updateActivity: (id, updates) => {
    set(state => ({
      activities: state.activities.map(activity =>
        activity.id === id ? { ...activity, ...updates } as Activity : activity
      ),
    }));
  },

  removeActivity: (id) => {
    set(state => ({ activities: state.activities.filter(activity => activity.id !== id) }));
  },
}));

export default useDynamicIslandStore;
