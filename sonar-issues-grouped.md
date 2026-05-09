# SonarQube Issues to Fix

### Rule: Prefer `String#replaceAll()` over `String#replace()`.
- h4nzs_nyx-chat:server/src/app.ts (Line: 141)
- h4nzs_nyx-chat:server/src/routes/auth.ts (Line: 787)
- h4nzs_nyx-chat:server/src/routes/auth.ts (Line: 788)
- h4nzs_nyx-chat:server/src/routes/messages.ts (Line: 206)
- h4nzs_nyx-chat:server/src/utils/logger.ts (Line: 10)
- h4nzs_nyx-chat:server/src/utils/logger.ts (Line: 11)
- h4nzs_nyx-chat:web/src/lib/socket.ts (Line: 483)
- h4nzs_nyx-chat:web/src/lib/socket.ts (Line: 483)
- h4nzs_nyx-chat:web/src/utils/sanitize.ts (Line: 39)
- h4nzs_nyx-chat:web/src/utils/sanitize.ts (Line: 42)
- h4nzs_nyx-chat:web/src/utils/url.ts (Line: 24)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 55)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 56)

### Rule: `String.raw` should be used to avoid escaping `\`.
- h4nzs_nyx-chat:server/src/app.ts (Line: 141)
- h4nzs_nyx-chat:web/src/components/ErrorBoundary.tsx (Line: 34)

### Rule: Handle this exception or don't catch it at all.
- h4nzs_nyx-chat:server/src/routes/auth.ts (Line: 51)
- h4nzs_nyx-chat:server/src/routes/auth.ts (Line: 629)
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 423)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 1035)
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 774)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2452)
- h4nzs_nyx-chat:web/src/store/messageInput.ts (Line: 292)
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 118)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 199)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 214)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 226)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 271)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1979)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1985)
- h4nzs_nyx-chat:web/src/pages/Login.tsx (Line: 290)
- h4nzs_nyx-chat:web/src/components/LinkedDevicesPanel.tsx (Line: 41)
- h4nzs_nyx-chat:web/src/components/LinkedDevicesPanel.tsx (Line: 76)
- h4nzs_nyx-chat:web/src/pages/Login.tsx (Line: 209)
- h4nzs_nyx-chat:web/e2e/auth.spec.ts (Line: 32)
- h4nzs_nyx-chat:web/e2e/auth.spec.ts (Line: 41)
- h4nzs_nyx-chat:web/e2e/auth.spec.ts (Line: 93)
- h4nzs_nyx-chat:web/e2e/auth.spec.ts (Line: 99)
- h4nzs_nyx-chat:web/e2e/chat.spec.ts (Line: 38)
- h4nzs_nyx-chat:web/e2e/profile.spec.ts (Line: 29)
- h4nzs_nyx-chat:web/e2e/profile.spec.ts (Line: 38)
- h4nzs_nyx-chat:web/e2e/security.spec.ts (Line: 29)
- h4nzs_nyx-chat:web/e2e/security.spec.ts (Line: 38)
- h4nzs_nyx-chat:web/e2e/settings.spec.ts (Line: 29)
- h4nzs_nyx-chat:web/e2e/settings.spec.ts (Line: 38)

### Rule: Refactor this function to reduce its Cognitive Complexity from 33 to the 15 allowed.
- h4nzs_nyx-chat:server/src/routes/auth.ts (Line: 263)

### Rule: Prefer using an optional chain expression instead, as it's more concise and easier to read.
- h4nzs_nyx-chat:server/src/routes/auth.ts (Line: 842)
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 486)
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 612)
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 645)
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 743)
- h4nzs_nyx-chat:server/src/routes/uploads.ts (Line: 205)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 342)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 567)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 635)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 679)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 694)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 1026)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 1060)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 1085)
- h4nzs_nyx-chat:web/src/components/ChatWindow.tsx (Line: 415)
- h4nzs_nyx-chat:web/src/components/LazyImage.tsx (Line: 71)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 901)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 242)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 262)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1049)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2770)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2825)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3592)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3824)
- h4nzs_nyx-chat:web/src/store/verification.ts (Line: 26)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1310)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1316)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1317)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1983)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 2566)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 2843)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 3018)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1070)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 215)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 209)
- h4nzs_nyx-chat:web/src/store/verification.ts (Line: 60)
- h4nzs_nyx-chat:web/src/components/UserInfoPanel.tsx (Line: 97)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 510)

### Rule: This assertion is unnecessary since it does not change the type of the expression.
- h4nzs_nyx-chat:server/src/routes/auth.ts (Line: 934)
- h4nzs_nyx-chat:web/src/lib/api.ts (Line: 50)
- h4nzs_nyx-chat:web/src/lib/crypto-worker-proxy.ts (Line: 34)
- h4nzs_nyx-chat:web/src/lib/shadowVaultDb.ts (Line: 207)
- h4nzs_nyx-chat:web/src/lib/shadowVaultDb.ts (Line: 371)
- h4nzs_nyx-chat:web/src/lib/webrtc.ts (Line: 141)
- h4nzs_nyx-chat:web/src/pages/Register.tsx (Line: 152)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 83)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3125)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3272)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3333)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3338)
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 75)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 751)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1382)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1315)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1770)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1770)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1771)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1772)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1772)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1804)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1805)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1812)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 1815)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 2165)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 2494)
- h4nzs_nyx-chat:web/src/components/UserInfoModal.tsx (Line: 133)
- h4nzs_nyx-chat:web/src/components/UserInfoPanel.tsx (Line: 110)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 2393)
- h4nzs_nyx-chat:web/src/lib/shadowVaultDb.ts (Line: 377)

### Rule: Prefer `node:buffer` over `buffer`.
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 21)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 12)
- h4nzs_nyx-chat:server/src/routes/users.ts (Line: 12)

### Rule: Extract this nested ternary operation into an independent statement.
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 84)
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 103)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 281)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 294)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 314)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 420)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 433)
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 453)
- h4nzs_nyx-chat:web/src/App.tsx (Line: 389)
- h4nzs_nyx-chat:web/src/App.tsx (Line: 401)
- h4nzs_nyx-chat:web/src/components/CallOverlay.tsx (Line: 483)
- h4nzs_nyx-chat:web/src/components/CallOverlay.tsx (Line: 523)
- h4nzs_nyx-chat:web/src/components/CallOverlay.tsx (Line: 525)
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 298)
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 301)
- h4nzs_nyx-chat:web/src/components/CreateStoryModal.tsx (Line: 244)
- h4nzs_nyx-chat:web/src/components/MessageBubble.tsx (Line: 194)
- h4nzs_nyx-chat:web/src/components/MessageBubble.tsx (Line: 196)
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 277)
- h4nzs_nyx-chat:web/src/pages/Register.tsx (Line: 319)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 961)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 1353)
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 851)
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 876)
- h4nzs_nyx-chat:web/src/store/callStore.ts (Line: 101)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 989)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 444)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3708)
- h4nzs_nyx-chat:web/src/store/messageInput.ts (Line: 311)
- h4nzs_nyx-chat:web/src/store/messageInput.ts (Line: 475)
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 910)
- h4nzs_nyx-chat:web/src/components/CreateBurnerModal.tsx (Line: 125)
- h4nzs_nyx-chat:web/src/components/SafetyNumberModal.tsx (Line: 123)

### Rule: Remove this useless assignment to variable "remainingAdmin".
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 704)

### Rule: Refactor this function to reduce its Cognitive Complexity from 28 to the 15 allowed.
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 229)

### Rule: This assertion is unnecessary since the receiver accepts the original type of the expression.
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 543)
- h4nzs_nyx-chat:web/src/components/MessageBubble.tsx (Line: 92)
- h4nzs_nyx-chat:web/src/hooks/useUserProfile.ts (Line: 49)
- h4nzs_nyx-chat:web/src/pages/MigrationSendPage.tsx (Line: 118)

### Rule: Prefer `Number.parseInt` over `parseInt`.
- h4nzs_nyx-chat:server/src/routes/messages.ts (Line: 168)
- h4nzs_nyx-chat:server/src/routes/uploads.ts (Line: 77)
- h4nzs_nyx-chat:server/src/routes/uploads.ts (Line: 83)
- h4nzs_nyx-chat:server/src/routes/uploads.ts (Line: 160)
- h4nzs_nyx-chat:server/src/socket.ts (Line: 591)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 1026)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 358)
- h4nzs_nyx-chat:server/src/routes/uploads.ts (Line: 137)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 61)

### Rule: Unnecessary escape character: \..
- h4nzs_nyx-chat:server/src/routes/messages.ts (Line: 206)

### Rule: Prefer `.at(…)` over `[….length - index]`.
- h4nzs_nyx-chat:server/src/routes/messages.ts (Line: 209)
- h4nzs_nyx-chat:server/src/routes/users.ts (Line: 397)

### Rule: `participantUserIds` should be a `Set`, and use `participantUserIds.has()` to check existence or non-existence.
- h4nzs_nyx-chat:server/src/routes/sessionKeys.ts (Line: 123)

### Rule: Exporting mutable 'let' binding, use 'const' instead.
- h4nzs_nyx-chat:server/src/socket.ts (Line: 46)

### Rule: Refactor this function to reduce its Cognitive Complexity from 16 to the 15 allowed.
- h4nzs_nyx-chat:server/src/socket.ts (Line: 421)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 250)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 418)
- h4nzs_nyx-chat:server/src/routes/messages.ts (Line: 196)

### Rule: Refactor this function to reduce its Cognitive Complexity from 25 to the 15 allowed.
- h4nzs_nyx-chat:server/src/socket.ts (Line: 772)
- h4nzs_nyx-chat:web/src/sw.ts (Line: 36)
- h4nzs_nyx-chat:web/src/components/Lightbox.tsx (Line: 86)

### Rule: `participantIds` should be a `Set`, and use `participantIds.has()` to check existence or non-existence.
- h4nzs_nyx-chat:server/src/socket.ts (Line: 926)

### Rule: Unnecessary escape character: \-.
- h4nzs_nyx-chat:server/src/utils/secureLinkPreview.ts (Line: 32)

### Rule: 'statusCode || 'unknown'' will use Object's default stringification format ('[object Object]') when stringified.
- h4nzs_nyx-chat:server/src/utils/sendPushNotification.ts (Line: 71)

### Rule: Remove this unused import of 'initWebRTCListeners'.
- h4nzs_nyx-chat:web/src/App.tsx (Line: 57)

### Rule: Prefer `globalThis` over `window`.
- h4nzs_nyx-chat:web/src/App.tsx (Line: 264)
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 80)
- h4nzs_nyx-chat:web/src/components/CommandPalette.tsx (Line: 69)
- h4nzs_nyx-chat:web/src/components/CommandPalette.tsx (Line: 70)
- h4nzs_nyx-chat:web/src/components/ContextMenu.tsx (Line: 124)
- h4nzs_nyx-chat:web/src/components/ContextMenu.tsx (Line: 130)
- h4nzs_nyx-chat:web/src/components/EncryptionStatusNotification.tsx (Line: 45)
- h4nzs_nyx-chat:web/src/components/EncryptionStatusNotification.tsx (Line: 72)
- h4nzs_nyx-chat:web/src/components/EncryptionStatusNotification.tsx (Line: 73)
- h4nzs_nyx-chat:web/src/components/ErrorBoundary.tsx (Line: 40)
- h4nzs_nyx-chat:web/src/components/Lightbox.tsx (Line: 74)
- h4nzs_nyx-chat:web/src/components/Lightbox.tsx (Line: 77)
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 565)
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 566)
- h4nzs_nyx-chat:web/src/components/MessageItem.tsx (Line: 404)
- h4nzs_nyx-chat:web/src/components/PasswordPromptModal.tsx (Line: 33)
- h4nzs_nyx-chat:web/src/components/PasswordPromptModal.tsx (Line: 34)
- h4nzs_nyx-chat:web/src/hooks/useEdgeSwipe.ts (Line: 36)
- h4nzs_nyx-chat:web/src/hooks/useEdgeSwipe.ts (Line: 37)
- h4nzs_nyx-chat:web/src/hooks/useOrientation.ts (Line: 12)
- h4nzs_nyx-chat:web/src/hooks/useOrientation.ts (Line: 13)
- h4nzs_nyx-chat:web/src/lib/nukeProtocol.ts (Line: 43)
- h4nzs_nyx-chat:web/src/lib/nukeProtocol.ts (Line: 71)
- h4nzs_nyx-chat:web/src/lib/nukeProtocol.ts (Line: 75)
- h4nzs_nyx-chat:web/src/lib/socket.ts (Line: 513)
- h4nzs_nyx-chat:web/src/pages/KeyManagementPage.tsx (Line: 87)
- h4nzs_nyx-chat:web/src/pages/MigrationReceivePage.tsx (Line: 161)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 320)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 360)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 361)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 575)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 584)
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 747)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 428)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 430)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 475)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 257)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 305)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 310)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 966)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1113)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1122)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1349)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3212)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3310)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3354)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3562)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 429)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 35)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 39)

### Rule: Refactor this code to not nest functions more than 4 levels deep.
- h4nzs_nyx-chat:web/src/components/AddParticipantModal.tsx (Line: 56)
- h4nzs_nyx-chat:web/src/components/ChatWindow.tsx (Line: 416)
- h4nzs_nyx-chat:web/src/components/CreateGroupChat.tsx (Line: 52)
- h4nzs_nyx-chat:web/src/components/FileAttachment.tsx (Line: 143)
- h4nzs_nyx-chat:web/src/components/LazyImage.tsx (Line: 163)
- h4nzs_nyx-chat:web/src/components/LinkedDevicesPanel.tsx (Line: 75)
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 164)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 575)
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 267)
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 235)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 830)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 849)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 859)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 869)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 900)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 924)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 939)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 1014)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 1043)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 1074)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2180)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2339)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2362)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2432)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2467)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3241)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3248)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3249)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3407)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3464)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3494)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3824)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3827)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3874)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3908)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3930)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3951)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3994)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3998)
- h4nzs_nyx-chat:web/src/sw.ts (Line: 67)

### Rule: Refactor this function to reduce its Cognitive Complexity from 17 to the 15 allowed.
- h4nzs_nyx-chat:web/src/components/AuthForm.tsx (Line: 22)

### Rule: Mark the props of the component as read-only.
- h4nzs_nyx-chat:web/src/components/AuthForm.tsx (Line: 22)
- h4nzs_nyx-chat:web/src/components/ChatWindow.tsx (Line: 321)
- h4nzs_nyx-chat:web/src/components/FileAttachment.tsx (Line: 39)
- h4nzs_nyx-chat:web/src/components/ImageEditorModal.tsx (Line: 16)
- h4nzs_nyx-chat:web/src/components/MessageBubble.tsx (Line: 58)
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 159)
- h4nzs_nyx-chat:web/src/components/OnboardingTour.tsx (Line: 32)
- h4nzs_nyx-chat:web/src/components/RecoveryPhraseModal.tsx (Line: 27)
- h4nzs_nyx-chat:web/src/components/StartNewChat.tsx (Line: 62)
- h4nzs_nyx-chat:web/src/components/SwipeableItem.tsx (Line: 24)
- h4nzs_nyx-chat:web/src/components/ui/card.tsx (Line: 36)
- h4nzs_nyx-chat:web/src/components/ui/card.tsx (Line: 46)
- h4nzs_nyx-chat:web/src/components/CreateBurnerModal.tsx (Line: 13)
- h4nzs_nyx-chat:web/src/components/SafetyNumberModal.tsx (Line: 23)

### Rule: Media elements such as <audio> and <video> must have a <track> for captions.
- h4nzs_nyx-chat:web/src/components/CallOverlay.tsx (Line: 65)
- h4nzs_nyx-chat:web/src/components/CreateStoryModal.tsx (Line: 162)
- h4nzs_nyx-chat:web/src/components/Lightbox.tsx (Line: 199)
- h4nzs_nyx-chat:web/src/components/Lightbox.tsx (Line: 213)

### Rule: Remove this useless assignment to variable "setIsSpeakerphone".
- h4nzs_nyx-chat:web/src/components/CallOverlay.tsx (Line: 132)

### Rule: Ambiguous spacing after previous element span
- h4nzs_nyx-chat:web/src/components/ChatInfoModal.tsx (Line: 58)
- h4nzs_nyx-chat:web/src/pages/BurnerChat.tsx (Line: 156)

### Rule: Avoid non-native interactive elements. If using native HTML is not possible, add an appropriate role and support for tabbing, mouse, keyboard, and touch inputs to an interactive content element.
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 88)
- h4nzs_nyx-chat:web/src/components/DynamicIsland.tsx (Line: 38)
- h4nzs_nyx-chat:web/src/components/Lightbox.tsx (Line: 185)
- h4nzs_nyx-chat:web/src/components/MessageItem.tsx (Line: 505)
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 333)
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 340)

### Rule: Visible, non-interactive elements with click handlers must have at least one keyboard listener.
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 88)
- h4nzs_nyx-chat:web/src/components/DynamicIsland.tsx (Line: 38)
- h4nzs_nyx-chat:web/src/components/Lightbox.tsx (Line: 185)
- h4nzs_nyx-chat:web/src/components/MessageItem.tsx (Line: 505)
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 333)
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 340)

### Rule: Move this component definition out of the parent component and pass data as props.
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 230)
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 235)
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 241)
- h4nzs_nyx-chat:web/src/components/ChatWindow.tsx (Line: 662)
- h4nzs_nyx-chat:web/src/components/MarkdownMessage.tsx (Line: 43)

### Rule: Refactor this function to reduce its Cognitive Complexity from 22 to the 15 allowed.
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 249)

### Rule: Unexpected negated condition.
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 277)
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 392)
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 660)
- h4nzs_nyx-chat:web/src/components/ChatWindow.tsx (Line: 124)
- h4nzs_nyx-chat:web/src/components/RecoveryPhraseModal.tsx (Line: 142)
- h4nzs_nyx-chat:web/src/pages/Register.tsx (Line: 317)
- h4nzs_nyx-chat:web/src/pages/Register.tsx (Line: 319)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1527)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1623)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1692)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2158)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2455)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3722)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3726)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3730)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3734)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3738)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3742)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3746)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3750)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3754)
- h4nzs_nyx-chat:web/src/components/SafetyNumberModal.tsx (Line: 123)
- h4nzs_nyx-chat:server/src/lib/prisma.ts (Line: 22)

### Rule: Remove this useless assignment to variable "showConfirm".
- h4nzs_nyx-chat:web/src/components/ChatList.tsx (Line: 613)

### Rule: Remove this useless assignment to variable "stableKey".
- h4nzs_nyx-chat:web/src/components/ChatWindow.tsx (Line: 558)

### Rule: `selectedIds` should be a `Set`, and use `selectedIds.has()` to check existence or non-existence.
- h4nzs_nyx-chat:web/src/components/CreateGroupChat.tsx (Line: 63)

### Rule: Remove this unused import of 'FiFile'.
- h4nzs_nyx-chat:web/src/components/DynamicIsland.tsx (Line: 11)

### Rule: Remove this useless assignment to variable "openConversation".
- h4nzs_nyx-chat:web/src/components/DynamicIsland.tsx (Line: 17)

### Rule: Prefer `Math.max()` to simplify ternary expressions.
- h4nzs_nyx-chat:web/src/components/FileAttachment.tsx (Line: 28)

### Rule: Prefer `Number.parseFloat` over `parseFloat`.
- h4nzs_nyx-chat:web/src/components/FileAttachment.tsx (Line: 31)

### Rule: Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed.
- h4nzs_nyx-chat:web/src/components/FileAttachment.tsx (Line: 39)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3672)
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 80)
- h4nzs_nyx-chat:web/src/store/messageInput.ts (Line: 400)
- h4nzs_nyx-chat:web/scripts/ping-indexnow.js (Line: 31)

### Rule: Prefer `String#codePointAt()` over `String#charCodeAt()`.
- h4nzs_nyx-chat:web/src/components/ImageEditorModal.tsx (Line: 56)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 172)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 185)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 186)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 173)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 43)
- h4nzs_nyx-chat:web/src/lib/biometricUnlock.ts (Line: 44)

### Rule: 'If' statement should not be the only statement in 'else' block
- h4nzs_nyx-chat:web/src/components/LinkPreviewCard.tsx (Line: 52)
- h4nzs_nyx-chat:web/src/lib/api.ts (Line: 151)
- h4nzs_nyx-chat:web/src/App.tsx (Line: 254)

### Rule: Refactor this function to reduce its Cognitive Complexity from 48 to the 15 allowed.
- h4nzs_nyx-chat:web/src/components/MessageBubble.tsx (Line: 58)

### Rule: Remove this unused import of 'lazy'.
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 8)

### Rule: 'react-icons/fi' imported multiple times.
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 26)
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 43)

### Rule: Refactor this function to reduce its Cognitive Complexity from 43 to the 15 allowed.
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 159)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2062)

### Rule: Remove this useless assignment to variable "setEditingMessage".
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 220)

### Rule: `restrictedExtensions` should be a `Set`, and use `restrictedExtensions.has()` to check existence or non-existence.
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 434)

### Rule: '(from: number, length?: number): string' is deprecated.
- h4nzs_nyx-chat:web/src/components/MessageInput.tsx (Line: 922)

### Rule: Remove this unused import of 'Conversation'.
- h4nzs_nyx-chat:web/src/components/MessageItem.tsx (Line: 4)

### Rule: Remove this useless assignment to variable "addOptimisticMessage".
- h4nzs_nyx-chat:web/src/components/MessageItem.tsx (Line: 154)

### Rule: This statement will not be executed conditionally; only the first statement will be. The rest will execute unconditionally.
- h4nzs_nyx-chat:web/src/components/MessageItem.tsx (Line: 403)

### Rule: Promise-returning function provided to variable where a void return was expected.
- h4nzs_nyx-chat:web/src/components/MessageItem.tsx (Line: 405)

### Rule: Prefer `Date.now()` over `Date#getTime()`.
- h4nzs_nyx-chat:web/src/components/NotificationPopover.tsx (Line: 14)

### Rule: Use `new Array()` instead of `Array()`.
- h4nzs_nyx-chat:web/src/components/OnboardingTour.tsx (Line: 160)

### Rule: Do not use Array index in keys
- h4nzs_nyx-chat:web/src/components/OnboardingTour.tsx (Line: 164)
- h4nzs_nyx-chat:web/src/components/RecoveryPhraseModal.tsx (Line: 151)

### Rule: Remove this useless assignment to variable "isLoading".
- h4nzs_nyx-chat:web/src/components/PasswordPromptModal.tsx (Line: 17)
- h4nzs_nyx-chat:web/src/pages/ProfilePage.tsx (Line: 48)

### Rule: Remove this useless assignment to variable "error".
- h4nzs_nyx-chat:web/src/components/PasswordPromptModal.tsx (Line: 18)

### Rule: Prefer `Number.isFinite` over `isFinite`.
- h4nzs_nyx-chat:web/src/components/StoryViewer.tsx (Line: 363)

### Rule: Remove this useless assignment to variable "participant".
- h4nzs_nyx-chat:web/src/components/TypingIndicator.tsx (Line: 33)

### Rule: Prefer `Number.isNaN` over `isNaN`.
- h4nzs_nyx-chat:web/src/components/VoiceMessagePlayer.tsx (Line: 214)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 62)

### Rule: The empty object is useless.
- h4nzs_nyx-chat:web/src/lib/api.ts (Line: 63)
- h4nzs_nyx-chat:web/src/lib/biometricUnlock.ts (Line: 121)
- h4nzs_nyx-chat:web/src/lib/biometricUnlock.ts (Line: 175)

### Rule: Remove this unused import of 'DoubleRatchetState'.
- h4nzs_nyx-chat:web/src/lib/db.ts (Line: 8)

### Rule: Prefer `String.fromCodePoint()` over `String.fromCharCode()`.
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 171)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 184)
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 33)
- h4nzs_nyx-chat:web/src/lib/biometricUnlock.ts (Line: 35)

### Rule: Use `export…from` to re-export `VaultEntry`.
- h4nzs_nyx-chat:web/src/lib/keychainDb.ts (Line: 481)

### Rule: Refactor this function to reduce its Cognitive Complexity from 30 to the 15 allowed.
- h4nzs_nyx-chat:web/src/lib/shadowVaultDb.ts (Line: 309)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 722)

### Rule: '@nyx/shared' imported multiple times.
- h4nzs_nyx-chat:web/src/lib/socket.ts (Line: 21)
- h4nzs_nyx-chat:web/src/lib/socket.ts (Line: 22)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 9)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 33)
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 15)
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 18)

### Rule: Remove this unused import of 'IncomingMessageSchema'.
- h4nzs_nyx-chat:web/src/lib/socket.ts (Line: 22)

### Rule: Remove this useless assignment to variable "pc".
- h4nzs_nyx-chat:web/src/lib/webrtc.ts (Line: 244)
- h4nzs_nyx-chat:web/src/lib/webrtc.ts (Line: 260)

### Rule: Prefer top-level await over using a promise chain.
- h4nzs_nyx-chat:web/src/main.tsx (Line: 70)
- h4nzs_nyx-chat:server/src/index.ts (Line: 23)

### Rule: Remove this useless assignment to variable "activeSessions".
- h4nzs_nyx-chat:web/src/pages/BurnerChat.tsx (Line: 19)

### Rule: Remove this useless assignment to variable "navigate".
- h4nzs_nyx-chat:web/src/pages/Chat.tsx (Line: 28)
- h4nzs_nyx-chat:web/src/pages/MigrationReceivePage.tsx (Line: 29)

### Rule: Remove this unused import of 'FiRefreshCw'.
- h4nzs_nyx-chat:web/src/pages/KeyManagementPage.tsx (Line: 5)

### Rule: Remove this unused import of 'api'.
- h4nzs_nyx-chat:web/src/pages/KeyManagementPage.tsx (Line: 16)

### Rule: Remove this useless assignment to variable "logout".
- h4nzs_nyx-chat:web/src/pages/KeyManagementPage.tsx (Line: 24)
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 227)

### Rule: Remove this useless assignment to variable "signingPublicKeyB64".
- h4nzs_nyx-chat:web/src/pages/KeyManagementPage.tsx (Line: 77)

### Rule: Ambiguous spacing before next element strong
- h4nzs_nyx-chat:web/src/pages/KeyManagementPage.tsx (Line: 158)

### Rule: Remove this unused import of 'startAuthentication'.
- h4nzs_nyx-chat:web/src/pages/Login.tsx (Line: 10)

### Rule: Imported JSX component SEO must be in PascalCase
- h4nzs_nyx-chat:web/src/pages/Login.tsx (Line: 306)
- h4nzs_nyx-chat:web/src/pages/Register.tsx (Line: 283)

### Rule: Remove this unused import of 'FiCheck'.
- h4nzs_nyx-chat:web/src/pages/ProfilePage.tsx (Line: 15)

### Rule: Remove this unused import of 'UserId'.
- h4nzs_nyx-chat:web/src/pages/ProfilePage.tsx (Line: 21)
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 28)
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 17)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 5)

### Rule: Remove this useless assignment to variable "updateProfile".
- h4nzs_nyx-chat:web/src/pages/ProfilePage.tsx (Line: 33)

### Rule: Remove this useless assignment to variable "updateAvatar".
- h4nzs_nyx-chat:web/src/pages/ProfilePage.tsx (Line: 34)

### Rule: Remove this useless assignment to variable "setIsLoading".
- h4nzs_nyx-chat:web/src/pages/ProfilePage.tsx (Line: 48)

### Rule: Remove this useless assignment to variable "fileInputRef".
- h4nzs_nyx-chat:web/src/pages/ProfilePage.tsx (Line: 50)

### Rule: Use concise character class syntax '\w' instead of '[a-zA-Z0-9_]'.
- h4nzs_nyx-chat:web/src/pages/Register.tsx (Line: 85)

### Rule: Replace this union type with a type alias.
- h4nzs_nyx-chat:web/src/pages/SessionManagerPage.tsx (Line: 34)

### Rule: Remove this unused import of 'FiBell'.
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 26)

### Rule: Remove this unused import of 'FiDatabase'.
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 32)

### Rule: Remove this unused import of 'startRegistration'.
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 40)

### Rule: Remove this useless assignment to variable "emergencyLogout".
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 228)

### Rule: useState call is not destructured into value + setter pair
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 272)

### Rule: Prefer `childNode.remove()` over `parentNode.removeChild(childNode)`.
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 551)

### Rule: Prefer `Blob#text()` over `FileReader#readAsText(blob)`.
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 591)

### Rule: This conditional operation returns the same value whether the condition is "true" or "false".
- h4nzs_nyx-chat:web/src/pages/SettingsPage.tsx (Line: 961)

### Rule: Use `export…from` to re-export `User`.
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 132)

### Rule: 'errorDetails' will use Object's default stringification format ('[object Object]') when stringified.
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 850)
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 875)

### Rule: Expected non-Promise value in a boolean conditional.
- h4nzs_nyx-chat:web/src/store/burner.ts (Line: 72)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3114)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 705)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1066)

### Rule: Remove this unused import of 'MessageId'.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 18)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 7)

### Rule: Use `export…from` to re-export `MessageStatus`.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 36)

### Rule: Use `export…from` to re-export `RawServerMessage`.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 37)

### Rule: Use `export…from` to re-export `Message`.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 38)

### Rule: Use `export…from` to re-export `Participant`.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 39)

### Rule: Use `export…from` to re-export `Conversation`.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 40)

### Rule: Refactor this function to reduce its Cognitive Complexity from 20 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 382)

### Rule: Prefer `globalThis.window` over `window`.
- h4nzs_nyx-chat:web/src/store/conversation.ts (Line: 965)
- h4nzs_nyx-chat:web/src/utils/verificationPersistence.ts (Line: 17)

### Rule: Remove this unused import of 'ConversationId'.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 6)

### Rule: Remove this unused import of 'authFetch'.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 12)

### Rule: Remove this unused import of 'emitSessionKeyRequest'.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 15)

### Rule: Remove this unused import of 'useConnectionStore'.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 42)

### Rule: Refactor this function to reduce its Cognitive Complexity from 64 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 672)

### Rule: 'unknown' overrides all other types in this union type.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 928)

### Rule: Refactor this function to reduce its Cognitive Complexity from 37 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1046)

### Rule: Refactor this function to reduce its Cognitive Complexity from 150 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1522)

### Rule: Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1527)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1623)
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1692)

### Rule: Refactor this function to reduce its Cognitive Complexity from 24 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2349)

### Rule: Unnecessary use of conditional expression for default assignment.
- h4nzs_nyx-chat:web/src/store/messageInput.ts (Line: 311)
- h4nzs_nyx-chat:web/src/store/messageInput.ts (Line: 475)

### Rule: Remove this unused import of 'StoryId'.
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 15)

### Rule: Remove this unused import of 'asStoryId'.
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 16)

### Rule: Remove this unused import of 'asConversationId'.
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 16)

### Rule: Either use this collection's contents or remove the collection.
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 746)

### Rule: Remove this useless assignment to variable "actualCipher".
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1270)

### Rule: Refactor this function to reduce its Cognitive Complexity from 36 to the 15 allowed.
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1966)
- h4nzs_nyx-chat:web/src/components/FileAttachment.tsx (Line: 89)
- h4nzs_nyx-chat:web/src/components/LazyImage.tsx (Line: 83)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1110)

### Rule: Prefer `Blob#arrayBuffer()` over `FileReader#readAsArrayBuffer(blob)`.
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 2134)
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 2171)

### Rule: 'error' will use Object's default stringification format ('[object Object]') when stringified.
- h4nzs_nyx-chat:web/src/utils/sanitize.ts (Line: 36)
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 52)

### Rule: Merge this RUN instruction with the consecutive ones.
- h4nzs_nyx-chat:server/Dockerfile (Line: 34)

### Rule: Refactor this function to reduce its Cognitive Complexity from 70 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 2696)

### Rule: Refactor this function to reduce its Cognitive Complexity from 19 to the 15 allowed.
- h4nzs_nyx-chat:web/src/App.tsx (Line: 272)
- h4nzs_nyx-chat:web/src/store/story.ts (Line: 101)

### Rule: Refactor this function to reduce its Cognitive Complexity from 78 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 3132)

### Rule: Refactor this function to reduce its Cognitive Complexity from 21 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/messageInput.ts (Line: 222)

### Rule: Refactor this function to reduce its Cognitive Complexity from 396 to the 15 allowed.
- h4nzs_nyx-chat:web/src/workers/crypto.worker.ts (Line: 760)

### Rule: Refactor this function to reduce its Cognitive Complexity from 84 to the 15 allowed.
- h4nzs_nyx-chat:web/src/utils/crypto.ts (Line: 1253)

### Rule: Refactor this function to reduce its Cognitive Complexity from 62 to the 15 allowed.
- h4nzs_nyx-chat:web/src/lib/webrtc.ts (Line: 341)

### Rule: Remove this unused import of 'relaySessionKeys'.
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 17)

### Rule: `new Error()` is too unspecific for a type check. Use `new TypeError()` instead.
- h4nzs_nyx-chat:web/src/lib/keyStorage.ts (Line: 63)

### Rule: Refactor this function to reduce its Cognitive Complexity from 188 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 122)

### Rule: Refactor this function to reduce its Cognitive Complexity from 51 to the 15 allowed.
- h4nzs_nyx-chat:server/src/routes/keys.ts (Line: 346)

### Rule: Remove this unused import of 'computeFingerprint'.
- h4nzs_nyx-chat:web/src/components/UserInfoPanel.tsx (Line: 11)

### Rule: Refactor this function to reduce its Cognitive Complexity from 29 to the 15 allowed.
- h4nzs_nyx-chat:server/src/routes/conversations.ts (Line: 241)

### Rule: Refactor this function to reduce its Cognitive Complexity from 34 to the 15 allowed.
- h4nzs_nyx-chat:web/src/store/auth.ts (Line: 419)

### Rule: Remove this unused import of 'z'.
- h4nzs_nyx-chat:web/src/lib/socket.ts (Line: 4)

### Rule: The catch parameter `e1` should be named `error_`.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1979)

### Rule: The catch parameter `e2` should be named `error_`.
- h4nzs_nyx-chat:web/src/store/message.ts (Line: 1985)

### Rule: Prefer top-level await over an async function `pingIndexNow` call.
- h4nzs_nyx-chat:web/scripts/ping-indexnow.js (Line: 70)

### Rule: Prefer `globalThis` over `global`.
- h4nzs_nyx-chat:web/src/SetupTests.ts (Line: 40)
- h4nzs_nyx-chat:web/src/SetupTests.ts (Line: 40)

### Rule: Move async function 'registerAndBypass' to the outer scope.
- h4nzs_nyx-chat:web/e2e/auth.spec.ts (Line: 7)

