import type { NyxApiClient } from '../network/api.js';
import { encryptBlob } from '../crypto/attachment.js';

export interface SecureMediaMetadata {
  url: string;
  symmetricKey: string;
  nonce: string;
  mimeType: string;
}

interface PresignedUrlResponse {
  uploadUrl: string;
  fileUrl: string;
  fileId: string;
}

export class NyxAttachmentManager {
  private api: NyxApiClient;

  constructor(api: NyxApiClient) {
    this.api = api;
  }

  public async uploadSecureMedia(file: Blob, mimeType: string): Promise<SecureMediaMetadata> {
    // 1. Encrypt the file
    const { encryptedBlob, symmetricKey, nonce } = await encryptBlob(file);

    // 2. Request a presigned URL from the backend
    const presignedResponse = await this.api.request<PresignedUrlResponse>('/uploads/presigned', {
      method: 'POST',
      body: JSON.stringify({ contentType: mimeType })
    });

    // 3. Upload the encrypted blob directly to the presigned URL
    // Use native fetch to avoid appending NYX API authentication headers
    const uploadResponse = await fetch(presignedResponse.uploadUrl, {
      method: 'PUT',
      body: encryptedBlob,
      headers: {
        'Content-Type': 'application/octet-stream' // Always octet-stream for encrypted data
      }
    });

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload to presigned URL: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }

    // 4. Return metadata
    return {
      url: presignedResponse.fileUrl,
      symmetricKey,
      nonce,
      mimeType
    };
  }
}
