import React, { useRef, useState, useEffect } from 'react';
import { motion, useMotionValue, useTransform, useAnimation, PanInfo } from 'framer-motion';

export interface SwipeAction {
  icon: React.ReactNode;
  color: string;
  onAction: () => void;
  threshold?: number;
}

interface SwipeableItemProps {
  children: React.ReactNode;
  leftAction?: SwipeAction; // Revealed when swiping RIGHT (pulling from left)
  rightAction?: SwipeAction; // Revealed when swiping LEFT (pulling from right)
  disableSwipe?: boolean;
}

export default function SwipeableItem({ children, leftAction, rightAction, disableSwipe = false }: SwipeableItemProps) {
  const x = useMotionValue(0);
  const controls = useAnimation();
  const [triggered, setTriggered] = useState<"left" | "right" | null>(null);

  // Background colors
  const bgLeft = leftAction?.color || 'bg-blue-500';
  const bgRight = rightAction?.color || 'bg-red-500';

  // Transform constraints and visuals
  const leftThreshold = leftAction?.threshold || 80;
  const rightThreshold = rightAction?.threshold || -80;

  // Scale icons based on swipe distance
  const leftIconScale = useTransform(x, [0, leftThreshold], [0.5, 1]);
  const rightIconScale = useTransform(x, [0, rightThreshold], [0.5, 1]);

  // Opacity for background
  const leftBgOpacity = useTransform(x, [0, leftThreshold / 2, leftThreshold], [0, 0.5, 1]);
  const rightBgOpacity = useTransform(x, [0, rightThreshold / 2, rightThreshold], [0, 0.5, 1]);

  // Haptic feedback state to avoid triggering multiple times
  const hapticRef = useRef({ left: false, right: false });

  useEffect(() => {
    return x.on('change', (latest) => {
      // Haptic for Left Action (Swiping Right)
      if (leftAction && latest >= leftThreshold) {
        if (!hapticRef.current.left) {
          if (navigator.vibrate) navigator.vibrate(50);
          hapticRef.current.left = true;
          setTriggered("left");
        }
      } else {
        hapticRef.current.left = false;
        if (latest > 0) setTriggered(null);
      }

      // Haptic for Right Action (Swiping Left)
      if (rightAction && latest <= rightThreshold) {
        if (!hapticRef.current.right) {
          if (navigator.vibrate) navigator.vibrate(50);
          hapticRef.current.right = true;
          setTriggered("right");
        }
      } else {
        hapticRef.current.right = false;
        if (latest < 0) setTriggered(null);
      }
    });
  }, [x, leftAction, rightAction, leftThreshold, rightThreshold]);

  const handleDragEnd = async (e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (disableSwipe) return;

    if (leftAction && info.offset.x >= leftThreshold) {
      if (navigator.vibrate) navigator.vibrate(100);
      leftAction.onAction();
    } else if (rightAction && info.offset.x <= rightThreshold) {
      if (navigator.vibrate) navigator.vibrate(100);
      rightAction.onAction();
    }

    // Always bounce back
    setTriggered(null);
    controls.start({ x: 0, transition: { type: 'spring', stiffness: 400, damping: 30 } });
  };

  return (
    <div className="relative w-full overflow-hidden rounded-2xl touch-pan-y">
      {/* Background Actions */}
      <div className="absolute inset-0 flex items-center justify-between px-4 pointer-events-none rounded-2xl">
        {leftAction && (
          <motion.div 
            className={`absolute inset-y-0 left-0 flex items-center pl-6 pr-12 rounded-l-2xl ${bgLeft} text-white`}
            style={{ opacity: leftBgOpacity, clipPath: 'inset(0)' }}
          >
            <motion.div style={{ scale: leftIconScale }} className={triggered === "left" ? "scale-125 transition-transform" : ""}>
              {leftAction.icon}
            </motion.div>
          </motion.div>
        )}
        
        {rightAction && (
          <motion.div 
            className={`absolute inset-y-0 right-0 flex items-center pr-6 pl-12 rounded-r-2xl justify-end ${bgRight} text-white`}
            style={{ opacity: rightBgOpacity, clipPath: 'inset(0)' }}
          >
            <motion.div style={{ scale: rightIconScale }} className={triggered === "right" ? "scale-125 transition-transform" : ""}>
              {rightAction.icon}
            </motion.div>
          </motion.div>
        )}
      </div>

      {/* Foreground Swipeable Content */}
      <motion.div
        drag={disableSwipe ? false : "x"}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.2}
        dragDirectionLock={true}
        onDragEnd={handleDragEnd}
        animate={controls}
        style={{ x }}
        className="relative z-10 w-full"
      >
        {children}
      </motion.div>
    </div>
  );
}
