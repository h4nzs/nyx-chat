import React, { useCallback } from 'react';
import { useSystemStore } from '../store/systemStore';
import { FiAlertTriangle, FiInfo, FiAlertCircle, FiX, FiExternalLink } from 'react-icons/fi';
import { useNavigate } from 'react-router-dom';

export const SystemBanner: React.FC = () => {
  const { banner, setBanner } = useSystemStore();
  const navigate = useNavigate();

  const handleDismiss = useCallback(() => {
    if (banner.alertType) {
      localStorage.setItem(`nyx_dismissed_${banner.alertType}`, new Date().toDateString());
    }
    setBanner({ ...banner, active: false });
  }, [banner, setBanner]);

  const handleAction = useCallback(() => {
    if (banner.actionLink) {
      navigate(banner.actionLink);
    }
  }, [banner.actionLink, navigate]);

  if (!banner.active || !banner.message) return null;

  const colors = {
    info: 'bg-[#0B0F19]/80 border-cyan-500/30 text-cyan-400 shadow-[0_8px_32px_rgba(8,145,178,0.25)]',
    warning: 'bg-[#0B0F19]/80 border-amber-500/30 text-amber-400 shadow-[0_8px_32px_rgba(217,119,6,0.25)]',
    error: 'bg-[#0B0F19]/80 border-rose-500/30 text-rose-400 shadow-[0_8px_32px_rgba(225,29,72,0.25)]'
  };

  const Icon = banner.type === 'error' ? FiAlertCircle : banner.type === 'warning' ? FiAlertTriangle : FiInfo;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 w-[95%] max-w-fit z-[100] pointer-events-none flex justify-center">
      
      <div 
        className={`pointer-events-auto flex items-center gap-2 px-5 py-2.5 rounded-full border backdrop-blur-xl transition-all duration-500 ease-out animate-in slide-in-from-top-4 fade-in-0 ${colors[banner.type]}`}
      >
        <Icon className="w-4 h-4 flex-shrink-0 animate-pulse" />
        <span className="text-sm font-medium tracking-wide text-center">
          {banner.message}
        </span>

        {banner.actionText && banner.actionLink && (
          <button
            onClick={handleAction}
            className="flex items-center gap-1 ml-1 px-3 py-1 text-xs font-semibold rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          >
            {banner.actionText}
            <FiExternalLink className="w-3 h-3" />
          </button>
        )}

        <button
          onClick={handleDismiss}
          className="ml-1 p-1 rounded-full hover:bg-white/10 transition-colors"
          aria-label="Dismiss"
        >
          <FiX className="w-3.5 h-3.5" />
        </button>
      </div>
      
    </div>
  );
};