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
      return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
    }
    // Jika cuma 1 kata, ambil 2 huruf pertamanya (misal: "Budi" -> "BU")
    return cleanName.substring(0, 2).toUpperCase();
  };

  const initials = getInitials(name || 'User');
  
  // 2. Dapatkan warna konsisten berdasarkan ID atau Nama (fallback)
  const bgColor = getUserColor(id || name || 'default');

  // [docs/41 §8] Kontras: `getUserColor` menghasilkan spektrum terang-gelap,
  // jadi teks putih selalu gagal axe pada warna terang (run a11y Settings).
  // Pilih hitam/putih berdasarkan luminansi relatif warna latar — aturan yang
  // sama dipakai WCAG — alih-alih mematikan aturan color-contrast.
  const readableTextColor = (() => {
    const hex = bgColor.replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#ffffff';
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance =
      0.2126 * channel(parseInt(hex.slice(0, 2), 16)) +
      0.7152 * channel(parseInt(hex.slice(2, 4), 16)) +
      0.0722 * channel(parseInt(hex.slice(4, 6), 16));
    // Ambang 0.179 = titik potong kontras 4.5:1 untuk putih vs hitam.
    return luminance > 0.179 ? '#000000' : '#ffffff';
  })();

  return (
    <div 
      className={`flex items-center justify-center rounded-full font-bold tracking-wider select-none flex-shrink-0 ${className}`}
      style={{ backgroundColor: bgColor, color: readableTextColor }}
    >
      {initials}
    </div>
  );
}
