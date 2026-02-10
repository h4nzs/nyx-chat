// src/lib/fileUtils.ts
import imageCompression from 'browser-image-compression';

// Ambil ekstensi dari path/url (tanpa query string)
function getExtension(filename: string): string {
  if (!filename) return ""
  const clean = filename.split("?")[0].split("#")[0] // buang query/hash
  return clean.slice(((clean.lastIndexOf(".") - 1) >>> 0) + 2).toLowerCase()
}

// Cek apakah string (url/filepath) adalah gambar
export function isImageFile(filename: string): boolean {
  const ext = getExtension(filename)
  return ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)
}

// Cek apakah string adalah video
export function isVideoFile(filename: string): boolean {
  const ext = getExtension(filename)
  return ["mp4", "webm", "ogg"].includes(ext)
}

// Cek apakah string adalah audio
export function isAudioFile(filename: string): boolean {
  const ext = getExtension(filename)
  return ["mp3", "wav", "ogg"].includes(ext)
}

export async function compressImage(file: File): Promise<File> {
  // Skip kalau bukan gambar
  if (!file.type.startsWith('image/')) return file;
  // Skip kalau file kecil (< 1MB)
  if (file.size < 1024 * 1024) return file;

  const options = {
    maxSizeMB: 1,          // Target maksimal 1MB
    maxWidthOrHeight: 1920, // Resize kalau resolusi kegedean (4K turun ke FHD)
    useWebWorker: true,    // Biar UI gak nge-freeze
  };

  try {
    const compressedFile = await imageCompression(file, options);
    return compressedFile;
  } catch (error) {
    return file;
  }
}