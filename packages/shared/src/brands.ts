export type Branded<T, Brand> = T & { readonly __brand: Brand };

export type UserId = Branded<string, 'UserId'>;
export type ConversationId = Branded<string, 'ConversationId'>;
export type MessageId = Branded<string, 'MessageId'>;
export type StoryId = Branded<string, 'StoryId'>;

export const asUserId = (id: string): UserId => id as unknown as UserId;
export const asConversationId = (id: string): ConversationId => id as unknown as ConversationId;
export const asMessageId = (id: string): MessageId => id as unknown as MessageId;
export const asStoryId = (id: string): StoryId => id as unknown as StoryId;
