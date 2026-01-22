import useNotificationStore from '@store/notification';
import { Link } from 'react-router-dom';
import { FiBell } from 'react-icons/fi';

const NotificationItem = ({ notification }: { notification: any }) => {
  const timeAgo = (timestamp: number) => {
    const seconds = Math.floor((new Date().getTime() - timestamp) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + "y ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + "mo ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + "d ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + "h ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + "m ago";
    return Math.floor(seconds) + "s ago";
  };

  const content = (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-secondary transition-colors">
      <div className="mt-1 flex-shrink-0">
        <FiBell className="text-accent-color" />
      </div>
      <div>
        <p className="text-sm text-text-primary">{notification.message}</p>
        <p className="text-xs text-text-secondary mt-0.5">{timeAgo(notification.timestamp)}</p>
      </div>
    </div>
  );

  if (notification.link) {
    return <Link to={notification.link}>{content}</Link>;
  }
  return content;
};

const NotificationPopover = () => {
  const { notifications, clearNotifications } = useNotificationStore(state => ({
    notifications: state.notifications,
    clearNotifications: state.clearNotifications,
  }));

  return (
    <div className="w-80 card-neumorphic rounded-xl">
      <div className="p-3 flex justify-between items-center border-b border-border">
        <h3 className="font-bold text-text-primary">Notifications</h3>
        {notifications.length > 0 && (
          <button onClick={clearNotifications} className="text-sm text-accent-color hover:underline">
            Clear All
          </button>
        )}
      </div>
      <div className="max-h-96 overflow-y-auto">
        {notifications.length === 0 ? (
          <p className="p-4 text-center text-text-secondary">No new notifications.</p>
        ) : (
          notifications.map(notif => <NotificationItem key={notif.id} notification={notif} />)
        )}
      </div>
    </div>
  );
};

export default NotificationPopover;
