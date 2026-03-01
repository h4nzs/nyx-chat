import { useEffect, useRef } from 'react';

export const useEdgeSwipe = (onSwipeRight: () => void, edgeThreshold = 40, swipeThreshold = 80) => {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch.clientX <= edgeThreshold) {
        touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;
      
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;

      if (deltaX > swipeThreshold && Math.abs(deltaY) < 60) {
        if (navigator.vibrate) navigator.vibrate(60);
        onSwipeRight();
      }
      touchStartRef.current = null;
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [onSwipeRight, edgeThreshold, swipeThreshold]);
};
