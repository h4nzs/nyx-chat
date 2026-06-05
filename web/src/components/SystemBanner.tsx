import React from 'react';
import { useSystemStore } from '../store/systemStore';
import { FiAlertTriangle, FiInfo, FiAlertCircle } from 'react-icons/fi';

export const SystemBanner: React.FC = () => {
  const { banner } = useSystemStore();

  if (!banner.active || !banner.message) return null;

  // Palet warna Neumorphism/Glassmorphism khas Nyx dengan shadow memendarkan cahaya
  const colors = {
    info: 'bg-[#0B0F19]/80 border-cyan-500/30 text-cyan-400 shadow-[0_8px_32px_rgba(8,145,178,0.25)]',
    warning: 'bg-[#0B0F19]/80 border-amber-500/30 text-amber-400 shadow-[0_8px_32px_rgba(217,119,6,0.25)]',
    error: 'bg-[#0B0F19]/80 border-rose-500/30 text-rose-400 shadow-[0_8px_32px_rgba(225,29,72,0.25)]'
  };

  const Icon = banner.type === 'error' ? FiAlertCircle : banner.type === 'warning' ? FiAlertTriangle : FiInfo;

  return (
    /* Wrapper absolute dengan pointer-events-none agar klik bisa tembus ke UI di bawahnya */
    <div className="absolute top-4 left-1/2 -translate-x-1/2 w-[95%] max-w-fit z-[100] pointer-events-none flex justify-center">
      
      <div 
        className={`pointer-events-auto flex items-center justify-center px-5 py-2.5 rounded-full border backdrop-blur-xl transition-all duration-500 ease-out animate-in slide-in-from-top-4 fade-in-0 ${colors[banner.type]}`}
      >
        <Icon className="w-4 h-4 mr-2.5 flex-shrink-0 animate-pulse" />
        <span className="text-sm font-medium tracking-wide text-center">
          {banner.message}
        </span>
      </div>
      
    </div>
  );
};