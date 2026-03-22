import useNotificationStore from '@store/notification';
import { Link } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { FiBell } from 'react-icons/fi';
import { useTranslation } from 'react-i18next';

const NotificationItem = ({ notification }: { notification: { message: string, timestamp: number, link?: string } }) => {
  const { t } = useTranslation(['common']);
  const timeAgo = (timestamp: number) => {
    const seconds = Math.floor((new Date().getTime() - timestamp) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return t('time.ago_y', { count: Math.floor(interval) });
    interval = seconds / 2592000;
    if (interval > 1) return t('time.ago_mo', { count: Math.floor(interval) });
    interval = seconds / 86400;
    if (interval > 1) return t('time.ago_d', { count: Math.floor(interval) });
    interval = seconds / 3600;
    if (interval > 1) return t('time.ago_h', { count: Math.floor(interval) });
    interval = seconds / 60;
    if (interval > 1) return t('time.ago_m', { count: Math.floor(interval) });
    return t('time.ago_s', { count: Math.floor(seconds) });
  };

  const content = (
    <div className="
      flex items-start gap-3 p-3 rounded-lg 
      bg-bg-main border-l-2 border-accent/50 
      hover:shadow-neu-pressed dark:hover:shadow-neu-pressed-dark 
      transition-all cursor-pointer
    ">
      <div className="mt-1 flex-shrink-0">
        <FiBell className="text-accent" />
      </div>
      <div>
        <p className="text-sm font-medium text-text-primary">{notification.message}</p>
        <p className="text-[10px] font-mono text-text-secondary mt-1 opacity-60">{timeAgo(notification.timestamp)}</p>
      </div>
    </div>
  );

  if (notification.link) {
    return <Link to={notification.link}>{content}</Link>;
  }
  return content;
};

const NotificationPopover = () => {
  const { t } = useTranslation(['modals']);
  const { notifications, clearNotifications } = useNotificationStore(useShallow(state => ({
    notifications: state.notifications,
    clearNotifications: state.clearNotifications,
  })));

  return (
    <div className="
      w-80 rounded-b-2xl rounded-tr-none rounded-tl-2xl
      bg-bg-main
      shadow-neu-flat dark:shadow-neu-flat-dark
      border-t-4 border-accent
      overflow-hidden
    ">
      <div className="p-4 flex justify-between items-center bg-bg-main shadow-neu-pressed dark:shadow-neu-pressed-dark mb-2">
        <h3 className="font-black text-xs uppercase tracking-widest text-text-primary">{t('notifications.title')}</h3>
        {notifications.length > 0 && (
          <button onClick={clearNotifications} className="text-[10px] font-mono text-accent hover:underline">
            {t('notifications.purge')}
          </button>
        )}
      </div>
      <div className="max-h-96 overflow-y-auto p-2 space-y-2">
        {notifications.length === 0 ? (
          <p className="p-4 text-center text-xs font-mono text-text-secondary opacity-60">{t('notifications.empty')}</p>
        ) : (
          notifications.map(notif => <NotificationItem key={notif.id} notification={notif} />)
        )}
      </div>
    </div>
  );
};

export default NotificationPopover;
