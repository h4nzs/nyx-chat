export async function generateStoryKey(): Promise<string> {
  const key = await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const exported = await window.crypto.subtle.exportKey('raw', key);
  return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

export async function encryptStoryPayload(payload: any, base64Key: string): Promise<string> {
  const rawKey = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  const cryptoKey = await window.crypto.subtle.importKey(
    'raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']
  );
  
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encodedPayload
  );
  
  const encryptedArray = new Uint8Array(encrypted);
  const combined = new Uint8Array(iv.length + encryptedArray.length);
  combined.set(iv);
  combined.set(encryptedArray, iv.length);
  
  return btoa(String.fromCharCode(...combined));
}

export async function decryptStoryPayload(encryptedDataB64: string, base64Key: string): Promise<any> {
  const rawKey = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  const cryptoKey = await window.crypto.subtle.importKey(
    'raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']
  );
  
  const combined = Uint8Array.from(atob(encryptedDataB64), c => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    data
  );
  
  const decoded = new TextDecoder().decode(decrypted);
  return JSON.parse(decoded);
}
