import { toAbsoluteUrl } from '@utils/url';
import { useNavigate } from 'react-router-dom';
import { useConversationStore } from '@store/conversation';
import { motion, AnimatePresence } from 'framer-motion';
import useDynamicIslandStore, { Activity, NotificationActivity, UploadActivity } from '@store/dynamicIsland';
import { FiFile, FiX, FiMessageSquare, FiUploadCloud } from 'react-icons/fi';
import { useUserProfile } from '@hooks/useUserProfile';

const NotificationView = ({ activity }: { activity: NotificationActivity }) => {
  const openConversation = useConversationStore(state => state.openConversation);
  const removeActivity = useDynamicIslandStore(state => state.removeActivity);
  const navigate = useNavigate();
  const profile = useUserProfile(activity.sender as any);

  const handleClick = () => {
    if (activity.link) {
      openConversation(activity.link);
      navigate('/');
    }
    removeActivity(activity.id);
  };

  return (
    <div onClick={handleClick} className="w-full h-full flex items-center gap-3 px-1 cursor-pointer group">
      <div className="relative">
        <img 
          src={profile.avatarUrl ? toAbsoluteUrl(profile.avatarUrl) : `https://api.dicebear.com/8.x/initials/svg?seed=${profile.name}`}
          alt="Avatar"
          className="w-8 h-8 rounded-full object-cover border border-white/10"
        />
        <div className="absolute -bottom-1 -right-1 bg-accent rounded-full p-0.5 border border-black">
           <FiMessageSquare size={8} className="text-white" />
        </div>
      </div>
      
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <div className="flex justify-between items-baseline">
           <p className="text-[10px] font-bold text-white/90 uppercase tracking-wider">{profile.name}</p>
           <span className="text-[8px] text-white/40 font-mono">NOW</span>
        </div>
        <p className="text-xs text-white/70 truncate font-medium group-hover:text-white transition-colors">
          {activity.message.substring(activity.message.indexOf(':') + 2)}
        </p>
      </div>
    </div>
  );
};

const UploadView = ({ activity }: { activity: UploadActivity }) => {
  const removeActivity = useDynamicIslandStore(state => state.removeActivity);

  return (
    <div className="w-full h-full flex items-center gap-3 px-1">
      <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/80">
        <FiUploadCloud size={14} className="animate-pulse" />
      </div>
      
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
        <div className="flex justify-between items-center">
           <p className="text-[10px] font-bold text-white/90 uppercase tracking-wider truncate max-w-[120px]">{activity.fileName}</p>
           <span className="text-[9px] font-mono text-accent">{Math.round(activity.progress)}%</span>
        </div>
        <div className="w-full bg-white/10 rounded-full h-1 overflow-hidden">
          <motion.div 
            className="bg-accent h-full rounded-full shadow-[0_0_10px_rgba(var(--accent),0.8)]" 
            initial={{ width: 0 }}
            animate={{ width: `${activity.progress}%` }}
            transition={{ type: "spring", damping: 20 }}
          />
        </div>
      </div>
      
      <button 
        onClick={(e) => { e.stopPropagation(); removeActivity(activity.id); }}
        className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-all"
      >
        <FiX size={12} />
      </button>
    </div>
  );
};

const DynamicIsland = () => {
  const activities = useDynamicIslandStore(state => state.activities);
  const currentActivity = activities[0]; 

  const renderActivity = (activity: Activity) => {
    switch (activity.type) {
      case 'notification': return <NotificationView activity={activity} />;
      case 'upload': return <UploadView activity={activity} />;
      default: return null;
    }
  }

  return (
    <div className="fixed top-2 left-0 right-0 z-[100] pointer-events-none flex justify-center">
      <AnimatePresence>
        {currentActivity && (
          <motion.div
            key={currentActivity.id}
            initial={{ height: 0, width: 100, opacity: 0, y: -20 }}
            animate={{ height: 48, width: 'auto', opacity: 1, y: 0, minWidth: 300 }}
            exit={{ height: 0, width: 100, opacity: 0, y: -20 }}
            transition={{ type: "spring", damping: 25, stiffness: 400 }}
            className="
              relative pointer-events-auto overflow-hidden
              bg-bg-main
              rounded-full px-4
              border border-white/50 dark:border-white/10
              shadow-[0_20px_40px_-10px_rgba(0,0,0,0.3)]
              dark:shadow-[0_20px_40px_-10px_rgba(0,0,0,0.7)]
              flex items-center
            "
          >
            {/* Glossy Reflection */}
            <div className="absolute top-0 left-0 right-0 h-1/2 bg-gradient-to-b from-white/5 to-transparent pointer-events-none" />
            
            {renderActivity(currentActivity)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DynamicIsland;