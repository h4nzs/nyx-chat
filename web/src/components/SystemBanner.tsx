import React from 'react';
import { useSystemStore } from '../store/systemStore';
import { FiAlertTriangle, FiInfo, FiAlertCircle } from 'react-icons/fi';

export const SystemBanner: React.FC = () => {
  const { banner } = useSystemStore();

  if (!banner.active || !banner.message) return null;

  const colors = {
    info: 'bg-cyan-900/50 border-cyan-500/50 text-cyan-100',
    warning: 'bg-amber-900/50 border-amber-500/50 text-amber-100',
    error: 'bg-rose-900/50 border-rose-500/50 text-rose-100'
  };

  const Icon = banner.type === 'error' ? FiAlertCircle : banner.type === 'warning' ? FiAlertTriangle : FiInfo;

  return (
    <div className={`relative flex items-center justify-center px-4 py-2 border-b backdrop-blur-md shadow-lg z-50 transition-all duration-500 ${colors[banner.type]}`}>
      <Icon className="w-4 h-4 mr-2 flex-shrink-0 animate-pulse" />
      <span className="text-sm font-medium tracking-wide text-center">
        {banner.message}
      </span>
    </div>
  );
};