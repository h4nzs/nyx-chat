import { dbRequest } from './base';
import { encryptField, decryptField } from '../encryption';

export class StoryRepository {
  static async saveStoryKey(storyId: string, base64Key: string): Promise<void> {
    const record = {
      story_id: storyId,
      key: await encryptField(base64Key)
    };
    await dbRequest('insert', 'storyKeys', record);
  }

  static async getStoryKey(storyId: string): Promise<string | null> {
    const r = await dbRequest('get', 'storyKeys', storyId);
    if (!r) return null;
    const decrypted = await decryptField(r.key);
    return decrypted as string;
  }
}
