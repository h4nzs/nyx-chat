import { api } from "./api";

interface PresignedResponse {
  uploadUrl: string;
  key: string;
  publicUrl: string;
}

export async function uploadToR2(
  file: File | Blob, 
  folder: 'avatars' | 'attachments' | 'groups',
  onProgress?: (percent: number) => void
): Promise<string> {
  
  // 1. Minta Presigned URL ke Server kita
  let presignedResponse: PresignedResponse;
  try {
    presignedResponse = await api<PresignedResponse>('/api/uploads/presigned', {
      method: 'POST',
      body: JSON.stringify({
        fileName: (file as File).name || 'blob',
        fileType: file.type,
        folder,
        fileSize: file.size
      })
    });
  } catch (error: any) {
    // Tangani error dari server jika ukuran file melebihi batas
    if (error.message && error.message.includes('File too large')) {
      throw new Error(error.message);
    }
    throw error;
  }

  const { uploadUrl, publicUrl } = presignedResponse;

  // 2. Upload LANGSUNG ke R2 (Bypass Server)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type);

    // Handle Progress
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(publicUrl); // Kembalikan URL publik R2
      } else {
        reject(new Error(`Upload failed: ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    
    xhr.send(file);
  });
}