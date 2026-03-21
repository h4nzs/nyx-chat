export type Branded<T, Brand> = T & {
    readonly __brand: Brand;
};
export type UserId = Branded<string, 'UserId'>;
export type ConversationId = Branded<string, 'ConversationId'>;
export type MessageId = Branded<string, 'MessageId'>;
export type StoryId = Branded<string, 'StoryId'>;
export declare const asUserId: (id: string) => UserId;
export declare const asConversationId: (id: string) => ConversationId;
export declare const asMessageId: (id: string) => MessageId;
export declare const asStoryId: (id: string) => StoryId;
//# sourceMappingURL=brands.d.ts.map