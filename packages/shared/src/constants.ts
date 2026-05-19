export const LIMITS = {
  RATE_LIMITS: {
    MESSAGES_PER_MINUTE: {
      UNVERIFIED: 5,
      FREE: 15,
      SUBSCRIBER: 50
    }
  },
  GROUP_CAPACITY: {
    UNVERIFIED: 0,
    FREE: 100,
    SUBSCRIBER: 500
  },
  FILE_UPLOAD: {
    UNVERIFIED: 0, // In bytes
    FREE: 100 * 1024 * 1024, // 100 MB
    SUBSCRIBER: 500 * 1024 * 1024, // 500 MB
    AVATAR: 5 * 1024 * 1024 // 5 MB
  }
};

export enum SubscriptionTier {
  FREE = "FREE",
  SUBSCRIBER = "SUBSCRIBER"
}
