import React from 'react';
import { FiShield, FiRefreshCw } from 'react-icons/fi';

export const MaintenancePage: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#0B0F19] text-slate-200 p-4">
      {/* Background Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-cyan-900/20 rounded-full blur-[100px] pointer-events-none" />

      {/* Neumorphic Card */}
      <div className="relative z-10 max-w-md w-full p-8 rounded-2xl bg-[#0F1423] border border-white/5 shadow-[8px_8px_16px_#060911,-8px_-8px_16px_#182035] flex flex-col items-center text-center">
        
        {/* Animated Icon Container */}
        <div className="w-20 h-20 mb-6 rounded-full flex items-center justify-center bg-[#0F1423] shadow-[inset_4px_4px_8px_#060911,inset_-4px_-4px_8px_#182035]">
          <FiShield className="w-8 h-8 text-cyan-400 animate-pulse" />
        </div>

        <h1 className="text-2xl font-bold mb-2 bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
          Sistem Sedang Diperbarui
        </h1>
        
        <p className="text-sm text-slate-400 mb-8 leading-relaxed">
          Arsitektur Nyx Core sedang mengalami peningkatan keamanan dan stabilitas. Kami akan segera kembali dalam beberapa saat.
        </p>

        {/* Neumorphic Button */}
        <button 
          onClick={onRetry}
          className="group flex items-center justify-center w-full py-3 px-4 rounded-xl bg-[#0F1423] text-cyan-400 font-semibold shadow-[4px_4px_8px_#060911,-4px_-4px_8px_#182035] active:shadow-[inset_4px_4px_8px_#060911,inset_-4px_-4px_8px_#182035] transition-all"
        >
          <FiRefreshCw className="w-4 h-4 mr-2 group-hover:rotate-180 transition-transform duration-500" />
          Cek Status Sekarang
        </button>
      </div>
    </div>
  );
};