// Copyright (c) 2026 [han]. All rights reserved.
// This file is part of NYX, licensed under the AGPL-3.0.
// For commercial licensing, contact [admin@nyx-app.my.id].

const OPFS_DIR_NAME = 'nyx_attachments_encrypted';
const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Gets the OPFS directory handle for NYX encrypted attachments.
 */
async function getOpfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(OPFS_DIR_NAME, { create: true });
}

/**
 * Saves an ENCRYPTED blob to the local OPFS cache.
 * WARNING: NEVER save plaintext data here to maintain Zero Trace security.
 */
export async function saveEncryptedToOPFS(fileId: string, encryptedBlob: Blob): Promise<void> {
  try {
    const dir = await getOpfsDir();
    // Sanitize fileId to prevent path issues (though fileId should be a base64 key)
    const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileHandle = await dir.getFileHandle(safeId, { create: true });
    
    const writable = await fileHandle.createWritable();
    await writable.write(encryptedBlob);
    await writable.close();
    
    // Asynchronously clear old files if we exceed the cache limit
    clearOldOPFS().catch(() => {});
  } catch (err) {
    console.warn("[OPFS] Failed to save encrypted blob:", err);
  }
}

/**
 * Retrieves an ENCRYPTED blob from the local OPFS cache.
 */
export async function getEncryptedFromOPFS(fileId: string): Promise<Blob | null> {
  try {
    const dir = await getOpfsDir();
    const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileHandle = await dir.getFileHandle(safeId);
    const file = await fileHandle.getFile();
    return file;
  } catch (err) {
    // Expected behavior if the file is not cached yet
    return null;
  }
}

/**
 * Basic LRU-style cleanup to keep OPFS cache under MAX_CACHE_SIZE_BYTES.
 */
export async function clearOldOPFS(): Promise<void> {
  try {
    const dir = await getOpfsDir();
    let totalSize = 0;
    const files: { name: string; size: number; lastModified: number }[] = [];

    // Note: TypeScript DOM lib doesn't fully type FileSystemDirectoryHandle async iterators yet,
    // so we use an 'any' cast or @ts-ignore for the entries() loop.
    // @ts-ignore
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        totalSize += file.size;
        files.push({ name, size: file.size, lastModified: file.lastModified });
      }
    }

    if (totalSize <= MAX_CACHE_SIZE_BYTES) return;

    // Sort by oldest first
    files.sort((a, b) => a.lastModified - b.lastModified);

    for (const f of files) {
      if (totalSize <= MAX_CACHE_SIZE_BYTES) break;
      await dir.removeEntry(f.name);
      totalSize -= f.size;
      console.log(`[OPFS] Evicted ${f.name} to free space.`);
    }
  } catch (err) {
    console.warn("[OPFS] Cleanup failed:", err);
  }
}
