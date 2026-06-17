import { useSystemStore } from '../store/systemStore';
import { useConversationStore } from '../store/conversation';
import { useMessageStore } from '../store/message';
import { asUserId, asConversationId, asMessageId, type Message, type ConversationUi, type User } from '@nyx/shared';

export async function processSystemAlert(user: User) {
  if (!user || !user.systemAlert) return;

  const alert = user.systemAlert;

  if (alert.type === 'subscription_expiring') {
    const todayStr = new Date().toDateString();
    
    // --- PERBAIKAN 1: CEK LOCAL STORAGE UNTUK BANNER ---
    const dismissedKey = `nyx_dismissed_${alert.type}`;
    const lastDismissed = localStorage.getItem(dismissedKey);

    if (lastDismissed !== todayStr) {
      // 1. Implementation of Option 3: Global Banner
      useSystemStore.getState().setBanner({
        active: true,
        type: 'warning',
        message: `NYX Pro expires in ${alert.daysLeft} days. Renew now to maintain priority relay and E2EE storage.`,
        alertType: alert.type,
        actionText: 'Renew Now',
        actionLink: '/settings'
      });
      
      // CATATAN UNTUK ANDA: Pastikan komponen Banner UI Anda (di React) 
      // memanggil `localStorage.setItem(dismissedKey, new Date().toDateString())` 
      // saat user menekan tombol [X] / Close pada banner.
    }

    // 2. Implementation of Option 1: Virtual System Message
    const conversationStore = useConversationStore.getState();
    const messageStore = useMessageStore.getState();

    const SYSTEM_CONV_ID = asConversationId('nyx_system_bot');
    const SYSTEM_USER_ID = asUserId('nyx_system_id');

    // Ensure the conversation exists in the list
    const existing = conversationStore.conversations.find(c => c.id === SYSTEM_CONV_ID);
    
    if (!existing) {
      const virtualConv: ConversationUi = {
        id: SYSTEM_CONV_ID,
        isGroup: false,
        participants: [
          { 
            id: SYSTEM_USER_ID, 
            username: 'nyx_billing', 
            name: 'NYX Billing',
            role: 'ADMIN' // Pastikan UI memberikan badge/tanda khusus untuk role ADMIN
          }
        ],
        updatedAt: new Date().toISOString(),
        unreadCount: 1,
        lastMessage: null,
        encryptionMode: 'SENDER_KEY'
      };

      await conversationStore.addOrUpdateConversation(virtualConv);
    }

    const content = `⚠️ **Subscription Expiring Soon**\n\nYour NYX Pro subscription will expire in **${alert.daysLeft} days**. \n\nPlease renew your plan to keep your E2EE storage active and maintain priority relay access.\n\n[Renew NYX Pro now →](/settings)`;
    
    const messages = messageStore.messages[SYSTEM_CONV_ID] || [];
    
    // --- PERBAIKAN 2: CEK DUPLIKASI BERDASARKAN KONTEN & HARI ---
    // Karena konten memiliki variabel ${alert.daysLeft}, pesan ini akan disuntikkan
    // SATU KALI SETIAP HARI selama 7 hari berturut-turut. Ini adalah strategi
    // reminder yang sangat bagus!
    const alreadyExists = messages.some(m => m.content === content);

    if (!alreadyExists) {
      const systemMessage: Message = {
        // ID ini sudah sangat bagus karena deterministik per hari
        id: asMessageId(`sys_${alert.type}_${alert.daysLeft}_${todayStr}`),
        conversationId: SYSTEM_CONV_ID,
        senderId: SYSTEM_USER_ID,
        content: content,
        type: 'SYSTEM',
        createdAt: new Date().toISOString(),
        status: 'SENT'
      };

      // 1. Persist to IndexedDB so it's visible in history
      const { shadowVault } = await import('@lib/shadowVaultDb');
      await shadowVault.upsertMessages([systemMessage]);

      // 2. Inject into the store
      await messageStore.addIncomingMessage(SYSTEM_CONV_ID, systemMessage);
    }
  }
}
