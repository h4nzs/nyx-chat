import React from 'react';
import { getUserColor } from '@utils/color';

interface DefaultAvatarProps {
  name?: string | null;
  id?: string; // Digunakan untuk menentukan warna agar konsisten
  className?: string;
}

export default function DefaultAvatar({ name, id, className = "w-8 h-8 text-xs" }: DefaultAvatarProps) {
  // 1. Ambil 1 atau 2 huruf pertama dari nama
  const getInitials = (str: string) => {
    const cleanName = str.trim();
    if (!cleanName) return '?';
    
    const words = cleanName.split(' ');
    if (words.length >= 2) {
      // Ambil huruf pertama dari kata pertama dan kedua (misal: "Budi Santoso" -> "BS")
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    // Jika cuma 1 kata, ambil 2 huruf pertamanya (misal: "Budi" -> "BU")
    return cleanName.substring(0, 2).toUpperCase();
  };

  const initials = getInitials(name || 'User');
  
  // 2. Dapatkan warna konsisten berdasarkan ID atau Nama (fallback)
  const bgColor = getUserColor(id || name || 'default');

  return (
    <div 
      className={`flex items-center justify-center rounded-full text-white font-bold tracking-wider select-none flex-shrink-0 ${className}`}
      style={{ backgroundColor: bgColor }}
    >
      {initials}
    </div>
  );
}
