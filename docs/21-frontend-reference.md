# 21 — Frontend Reference (Web App)

A complete inventory of `web/src`, written to help you find any module quickly. Feature-level behavior lives in `14`–`20`; this is the "what lives where and what it exposes" catalog.

## 21.1 Boot & shell

| File | Role |
|---|---|
| `main.tsx` | Entry: `zodSetup` (must be first) → i18n → render `App` → `registerServiceWorker`; injects `setAuthFailureHandler` (logout on final refresh failure, skipped during bootstrap) |
| `App.tsx` | BrowserRouter + routes; lazy pages under a routes-level `<Suspense>` (LoadingScreen); each global modal in its own `ModalSuspense` boundary (`fallback={null}`) + `preloadOnIdle` chunk warm-up; `bootstrap()`; socket connect; theme/accent; visibility lock; maintenance gate; toast limiter |
| `zodSetup.ts` | `globalThis.__zod_globalConfig.jitless = true` (direct mutation — `zod.config()` is tree-shaken) |
| `i18n.ts` | i18next + HttpBackend + LanguageDetector; `load:'languageOnly'`, `fallbackLng:'en'`, 7 runtime namespaces |
| `index.css` | Tailwind v4 `@theme`, `@custom-variant dark (&:where(.dark,.dark *))`, neumorphic shadows, aurora gradient |

## 21.2 Zustand stores (`store/`, 21 files)

| Store | Key state | Key actions |
|---|---|---|
| `auth.ts` | `user`, `accessToken`, `isBootstrapping`, `hasRestoredKeys`, `isUnlocking`, `blockedUserIds`, in-memory private-key cache | `bootstrap`, `login`, `registerAndGeneratePhrase`, `logout`, `emergencyLogout`, `silentRefresh` (retry 3×), `tryAutoUnlock`, `lockApp`, `setDecryptedKeys`, key/prekey getters, `blockUser`/`unblockUser`, `loadBlockedUsers`. Exports `setupAndUploadPreKeyBundle` |
| `message.ts` (2646 L) | `messages[conv]`, `pendingDecryptions`, `hasMore`, `hasLoadedHistory`, `selectedMessageIds`, `isFetchingMore` | `sendMessage`, `sendReaction`, `uploadFile`, `loadMessagesForConversation`, `loadPreviousMessages`, `loadMessageContext`, `addOptimisticMessage`, `addIncomingMessage`, `updateMessageStatus`, `retrySendMessage`, `processOfflineQueue`, `repairSecureSession`, `reDecryptPendingMessages`, `addSystemMessage`; re-exports `decryptMessageObject` |
| `conversation.ts` (942 L) | `conversations`, `activeId`, `isSidebarOpen`, `loading`, `initialLoadCompleted` | `loadConversations`, `startConversation`, `createGroup`, `addOrUpdateConversation`, `updateConversation`, `deleteConversation`, `deleteGroup`, `addParticipants`/`removeParticipant`/`updateParticipantRole`, `togglePinConversation`, `performHandshake`, `markKeyRotationNeeded`, `updateConversationLastMessage`, `resyncState` |
| `messageInput.ts` | `replyingTo`, `editingMessage`, `expiresIn`, `isViewOnce`, `isHD`, `isVoiceAnonymized`, `stagedFiles` | `sendMessage`, `uploadFile`, `sendEdit`, `fetchTypingLinkPreview`, `addStagedFiles`, `handleStopRecording`, `retrySendMessage` |
| `burner.ts` | `hostDeviceId/PqPk/ClassicalPk/UserId`, `activeSessions`, `messages`, `isInitialized` | `initializeFromHash`, `sendMessage`, `receiveMessage`, `terminateSession`, `destroyBurnerSession`, `reset`; exports `generateBurnerLink` |
| `callStore.ts` | `callState`, `remoteUsers/Streams`, `isVideoCall`, `isReceivingCall`, `localStream`, `isMinimized` | `setCallState`, `setIncomingCall`, `setOutgoingCall`, `add/removeRemote*`, `toggleMinimize`, `endCall`, `setCallKey` |
| `commandPalette.ts` | `isOpen`, `commands[]` | `open`, `close`, `toggle`, `addCommands`, `removeCommands` |
| `connection.ts` | `status`, `myDevices`, `hasFetchedDevices` | `setStatus`, `fetchMyDevices`; exports `clearReconnectTimer` |
| `contextMenu.ts` | `isOpen`, `x`, `y`, `options[]`, `reactions` | `openMenu`, `closeMenu` |
| `dynamicIsland.ts` | `activities[]` | `addActivity`, `updateActivity`, `removeActivity` |
| `keychain.ts` | `lastUpdated` | `keysUpdated()` |
| `messageSearch.ts` | `searchResults[]`, `highlightedMessageId`, `searchQuery`, `isSearching` | `searchMessages`, `setHighlightedMessageId`, `clearSearch` |
| `modal.ts` | confirm/profile/password-prompt/chat-info flags | `showConfirm`/`hideConfirm`, `open/closeProfileModal`, `show/hidePasswordPrompt`, `open/closeChatInfoModal` |
| `notification.ts` | `notifications[]`, `unreadCount` | `addNotification`, `markAllAsRead`, `clearNotifications`, `removeNotificationsForConversation` |
| `presence.ts` | `onlineUsers` (Set), `typingIndicators` | `setOnlineUsers`, `userJoined`, `userLeft`, `addOrUpdate`, `clear` |
| `profile.ts` | `profiles` cache | `decryptAndCache`, `getCacheOnly` |
| `settings.ts` | `privacyCloak` | `setPrivacyCloak` |
| `story.ts` | `stories[]`, `lastFetched`, `isLoading` | `fetchActiveStories`, `postStory` |
| `systemStore.ts` | `maintenance`, `banner` | `checkStatus` (60 s poll), `setBanner` |
| `theme.ts` | `theme`, `accent` | `toggleTheme`, `setAccent` |
| `verification.ts` | `verifiedStatus` | `loadInitialStatus`, `setVerified`, `unsetVerified`, `computeFingerprint` |

## 21.3 Lib modules (`lib/`, 26 files)

**Crypto / storage**
- `crypto-worker-proxy.ts` — main↔worker proxy: `deriveKeyFromPassword`, `registerAndGenerateKeys`, `generateNewKeys`, `retrievePrivateKeys`, `restoreFromPhrase`, `recoverAccountWithSignature`, `getRecoveryPhrase`, `encryptProfile`/`decryptProfile`/`generateProfileKey`, `hashUsername`, `minePoW`, `generateSafetyNumber`, `worker_crypto_secretbox_xchacha20poly1305_*`, `worker_crypto_box_seal(_open)`, `worker_pq_box_seal(_open)`, `worker_file_encrypt/decrypt`, `reEncryptBundleFromMasterKey`.
- `keyStorage.ts` — `save/getEncryptedKeys`, `clearKeys`, `hasStoredKeys`, `save/getDeviceAutoUnlockKey`, `set/getDeviceAutoUnlockReady`, `setPanicPassword`/`checkPanicPassword`.
- `keychainDb.ts` — at-rest `ENC1:` encrypt/decrypt; group sender/receiver state; skipped keys; OTPK; session keys; `exportDatabaseToJson`/`importDatabaseFromJson`; profile key; cached group participants.
- `shadowVaultDb.ts` — `shadowVault` proxy: conversation + message + PQ-DR session + story key persistence; `encryptVaultText`/`decryptVaultText`.
- `db.ts` — Dexie `NyxUnifiedDB` schema (all tables + indexes).
- `tokenStorage.ts` — cookie helpers.
- `biometricUnlock.ts` — WebAuthn PRF setup/unlock.
- `sodiumInitializer.ts` — `getSodium`, `initializeSodium`.
- `refreshLock.ts` — `runExclusive` cross-tab mutex.
- `opfsStorage.ts` — encrypted attachment OPFS cache.
- `burnerFileData.ts` — `extractBurnerFileData`.

**Auth / API / transport**
- `api.ts` — `api`, `authFetch` (CSRF + 401-refresh-retry), `apiUpload`, `getCsrfToken`, `handleApiError`, `setAuthFailureHandler`, `getPreKeyBundle`.
- `transportClient.ts` — `NyxWebTransportClient` (EventEmitter), `connectSocket`, `disconnectSocket`, `emitSessionKeyRequest/Fulfillment`, `emitGroupKeyDistribution/Request/Fulfillment`, `emitMetadataUpdated`, `fireGhostSync`; singleton `transportClient`.
- `socketListeners.ts` — `initSocketListeners()`: transport events → stores; offline sync.
- `webrtc.ts` — call signaling + peer connections.
- `serviceWorkerRegistration.ts`.

**Pipeline / media**
- `messagePipeline.ts` — `decryptMessageObject`, `evaluateControlMessage`, `createRepliedToForStoryReply`.
- `r2.ts` — `uploadToR2`.
- `fileUtils.ts` — `isImageFile`/`isVideoFile`/`isAudioFile`, `compressImage`.
- `prefetch.ts` — `prefetchAppChunks()` (lazy-chunk warm-up).
- `nukeProtocol.ts` — `executeLocalWipe`.
- `offlineQueueDb.ts` — offline send queue.
- `storyCrypto.ts` — story encrypt/decrypt.

## 21.4 Pages (`pages/`, 16)

`Login`, `Register`, `Restore`, `Chat`, `SettingsPage`, `KeyManagementPage`, `SessionManagerPage`, `ProfilePage`, `AdminDashboard`, `BurnerChat` (`/drop`), `ConnectPage`, `EmbedChatPage`, `MigrationReceivePage`, `MigrationSendPage`, `MaintenancePage`, `NotFoundPage`. (See the page table in `06-frontend.md` §6.8 and feature docs.)

## 21.5 Components (`components/`, 72 + `ui/`)

- **Global modals (lazy in App.tsx):** `ConfirmModal`, `UserInfoModal`, `PasswordPromptModal`, `ChatInfoModal`, `DynamicIsland`, `CommandPalette`, `ContextMenu`, `CallOverlay`, `SystemInitModal`.
- **Chat core:** `ChatList`, `ChatWindow`, `ChatItem` (conversation row), `MessageItem`, `MessageBubble`, `MessageInput`, `MessageSkeleton`, `TypingIndicator`, `Reactions`, `FileAttachment`, `LazyImage`, `LinkPreviewCard`, `VoiceMessagePlayer`, `MarkdownMessage`, `NewMessageToast`, `EncryptionStatusNotification`, `AuthForm` (shared login/register form).
- **Panels/modals:** `GroupInfoPanel`, `UserInfoPanel`, `ParticipantList`, `SearchMessages`, `CreateGroupChat`, `EditGroupInfoModal`, `AddParticipantModal`, `CreateBurnerModal`, `RecoveryPhraseModal`, `SubscriptionModal`, `CreateStoryModal`, `StoryViewer`, `StoryTray`, `ScanQRModal`, `ShareProfileModal`, `SafetyNumberModal`, `BanUserModal`, `ReportUserModal`, `ReportBugModal`, `Lightbox`, `MediaGallery`, `ImageCropperModal`, `ImageEditorModal`, `AttachmentCropperModal`, `OnboardingTour`, `StartNewChat`, `KeyManagement`.
- **Chrome:** `ConnectionStatusBanner`, `SystemBanner`, `PrivacyCloak`, `ErrorBoundary`, `SEO`, `LanguageSwitcher`, `ProtectedRoute`, `NotificationBell` (bell + popover trigger), `NotificationPopover` (in-app notification list).
- **`ui/` primitives:** `ModalBase`, `Portal`, `card`, `DefaultAvatar`, `AnimatedTabs`; plus `Spinner`, `Alert`, `OnlineDot`, `SwipeableItem`.

## 21.6 Workers (`workers/`)

- `crypto.worker.ts` (2453 L) — 45+ operations: identity keys, XChaCha primitives, Argon2id KDF, PoW, profiles, PQX3DH, Double Ratchet, group sender-key, burner PQ-DR, file secretstream, safety number. Protocol `{id,type,payload}` → `{id,success,result,error}`.
- `transport.worker.ts` (356 L) — WebTransport QUIC: CONNECT/DISCONNECT/SEND_STREAM/SEND_DATAGRAM/START_HANDSHAKE; chaffing loop; frame parsing.

## 21.7 Hooks (`hooks/`, 8) & utils (`utils/`, 13 + tests)

- Hooks: `useChatList`, `useConversation`, `useEdgeSwipe`, `useGlobalEscape`, `useGlobalShortcut`, `useOrientation`, `usePushNotifications`, `useUserProfile`.
- Utils: `crypto.ts` (1934 L — the key engine), `safetyNumber.ts`, `fingerprint.ts`, `typeGuards.ts`, `sanitize.ts`, `url.ts`, `verification.ts`, `systemAlerts.ts`, `feedback.ts`, `date.ts`, `color.ts`, `canvasUtils.ts`, `blobCache.ts`.

## 21.7b Types & test setup

- `types/crypto-common.ts` — `CryptoBuffer`, `SodiumKeyPair`, ratchet state/header aliases.
- `types/declarations.d.ts`, `vite-env.d.ts` — global/Vite declarations.
- `SetupTests.ts` — Vitest setup (mocks `localStorage` + `Web Worker`, Buffer polyfill).

## 21.8 i18n & PWA

- Locales `public/locales/{en,es,id,pt-BR}` × 7 namespaces (`common, auth, errors, chat, settings, modals, admin`) — exactly matching the `ns` array in `i18n.ts`. Every key must exist in all four languages. (Former `privacy/help/landing` namespaces were dead copies of the marketing site's locales and were removed — the marketing Astro site keeps its own under `marketing/src/locales`.)
- PWA: `vite-plugin-pwa` injectManifest, source `src/sw.ts`; no `/api` runtime caching by design.

## 21.9 E2E (`e2e/`, 7 specs + global setup)

`auth` (register/login), `chat` (2-page messaging), `profile` (name/bio), `security` (sessions), `settings` (emergency eject), `transport` (WebTransport latency + unsend, auto-skip when unsupported), `global.setup` (DB+Redis reset). Run serially (`workers: 1`).
