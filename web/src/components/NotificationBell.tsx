import * as Popover from '@radix-ui/react-popover';
import { FiBell } from 'react-icons/fi';
import useNotificationStore from '@store/notification';
import NotificationPopover from './NotificationPopover';
import { useEffect, useRef } from 'react';
import { motion, useAnimationControls } from 'framer-motion';

const NotificationBell = () => {
  const { unreadCount, markAllAsRead } = useNotificationStore(state => ({
    unreadCount: state.unreadCount,
    markAllAsRead: state.markAllAsRead,
  }));
  const controls = useAnimationControls();
  const prevUnreadCount = useRef(unreadCount);

  useEffect(() => {
    if (unreadCount > prevUnreadCount.current) {
      controls.start({
        rotate: [0, -15, 10, -10, 5, -5, 0],
        transition: { duration: 0.5, ease: 'easeInOut' },
      });
    }
    prevUnreadCount.current = unreadCount;
  }, [unreadCount, controls]);

  const handleOpenChange = (open: boolean) => {
    if (open && unreadCount > 0) {
      setTimeout(() => {
        markAllAsRead();
      }, 1000);
    }
  };

  return (
    <Popover.Root onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button className="btn-flat p-2 rounded-full text-text-secondary hover:text-text-primary">
          <motion.div animate={controls}>
            <FiBell />
          </motion.div>
          {unreadCount > 0 && (
            <span className="absolute top-0 right-0 block h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-bg-surface" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={10} align="end" className="z-50">
          <NotificationPopover />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

export default NotificationBell;